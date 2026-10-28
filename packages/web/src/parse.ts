import type { Db } from "./db/index.js";
import { decodeJsonPayload, parseClaudeCodeLogs, type ParsedRecord } from "./claude-code.js";
import { uuidv7 } from "./ids.js";

type Tx = Pick<Db, "query">;

const AGENT = "claude-code";

/** Columns per event row, and rows per insert (Postgres allows 65535 parameters in one statement). */
const EVENT_COLUMNS = 16;
const EVENT_BATCH = 500;

export interface SaveResult {
  /** Events newly stored. */
  added: number;
  /** Backfill records dropped because their turn (session and prompt) already had stored events. */
  backfillSkipped: number;
  /** Backfill turns (session and prompt) that were stored, and ones dropped because they already had events. */
  turnsAccepted: number;
  turnsSkipped: number;
}

/**
 * Writes parsed records for one org and user. A backfill record is dropped when its turn already had a stored event
 * before this call (checked up front, so a new turn is saved whole); live records are never dropped. Safe to run twice on the same records, and in any order:
 * a session, a prompt and an event are each found-or-created by their own ids, a session's span only widens,
 * and an event that arrives before its prompt's `user_prompt` makes the prompt, which the later one fills in.
 */
export async function saveRecords(tx: Tx, orgId: string, userId: string, records: ParsedRecord[]): Promise<SaveResult> {
  const accepted = new Set<string>();
  const skipped = new Set<string>();
  const stored = await turnsWithEvents(tx, orgId, records);
  let backfillSkipped = 0;
  const kept: ParsedRecord[] = [];
  for (const r of records) {
    if (r.backfill && r.promptId && stored.has(`${r.sessionId}\0${r.promptId}`)) {
      backfillSkipped++;
      skipped.add(`${r.sessionId}\0${r.promptId}`);
      continue;
    }
    if (r.backfill && r.promptId) accepted.add(`${r.sessionId}\0${r.promptId}`);
    kept.push(r);
  }

  // One span per session and one length per prompt, folded from every kept record: the same result as widening the
  // span and filling the length record by record, since both only ever move one way.
  const spans = new Map<string, { start: Date; end: Date }>();
  const prompts = new Map<string, { sessionId: string; externalId: string; length: number | null; start: Date }>();
  for (const r of kept) {
    const span = spans.get(r.sessionId);
    if (!span) spans.set(r.sessionId, { start: r.at, end: r.at });
    else {
      if (r.at < span.start) span.start = r.at;
      if (r.at > span.end) span.end = r.at;
    }
    if (!r.promptId) continue;
    const key = `${r.sessionId}\0${r.promptId}`;
    const length = r.type === "prompt" ? (r.promptLength ?? null) : null;
    const prompt = prompts.get(key);
    if (!prompt) prompts.set(key, { sessionId: r.sessionId, externalId: r.promptId, length, start: r.at });
    else {
      prompt.length ??= length;
      if (r.at < prompt.start) prompt.start = r.at;
    }
  }

  const sessions = new Map<string, string>();
  if (spans.size) {
    const ids = [...spans.keys()];
    const rows = await tx.query<{ id: string; external_id: string }>(
      `INSERT INTO sesh.sessions (id, org_id, user_id, agent, external_id, started_at, ended_at)
       SELECT new_id, $1, $2, $3, external_id, started_at, ended_at
       FROM unnest($4::uuid[], $5::text[], $6::timestamptz[], $7::timestamptz[])
         AS t(new_id, external_id, started_at, ended_at)
       ON CONFLICT (org_id, agent, external_id) DO UPDATE
         SET started_at = LEAST(sesh.sessions.started_at, EXCLUDED.started_at),
             ended_at = GREATEST(sesh.sessions.ended_at, EXCLUDED.ended_at)
       RETURNING id, external_id`,
      [
        orgId,
        userId,
        AGENT,
        ids.map(() => uuidv7()),
        ids,
        ids.map((id) => spans.get(id)!.start.toISOString()),
        ids.map((id) => spans.get(id)!.end.toISOString()),
      ],
    );
    for (const row of rows) sessions.set(row.external_id, row.id);
  }

  const promptIds = new Map<string, string>();
  if (prompts.size) {
    const list = [...prompts.values()];
    const rows = await tx.query<{ id: string; session_id: string; external_id: string }>(
      `INSERT INTO sesh.prompts (id, session_id, external_id, prompt_length, started_at)
       SELECT id, session_id, external_id, prompt_length, started_at
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::integer[], $5::timestamptz[])
         AS t(id, session_id, external_id, prompt_length, started_at)
       ON CONFLICT (session_id, external_id) DO UPDATE
         SET started_at = LEAST(sesh.prompts.started_at, EXCLUDED.started_at),
             prompt_length = COALESCE(sesh.prompts.prompt_length, EXCLUDED.prompt_length)
       RETURNING id, session_id, external_id`,
      [
        list.map(() => uuidv7()),
        list.map((p) => sessions.get(p.sessionId)),
        list.map((p) => p.externalId),
        list.map((p) => p.length),
        list.map((p) => p.start.toISOString()),
      ],
    );
    const externalSession = new Map([...sessions].map(([external, id]) => [id, external]));
    for (const row of rows) promptIds.set(`${externalSession.get(row.session_id)}\0${row.external_id}`, row.id);
  }

  let added = 0;
  const events = kept.filter((r) => r.type === "event");
  for (let i = 0; i < events.length; i += EVENT_BATCH) {
    const batch = events.slice(i, i + EVENT_BATCH);
    const params: unknown[] = [];
    const rows = batch.map((r) => {
      if (r.type !== "event") throw new Error("unreachable");
      const at = params.length;
      params.push(
        uuidv7(),
        sessions.get(r.sessionId),
        r.promptId ? (promptIds.get(`${r.sessionId}\0${r.promptId}`) ?? null) : null,
        r.dedupeKey,
        r.kind,
        r.at,
        r.model ?? null,
        r.inputTokens ?? null,
        r.outputTokens ?? null,
        r.cacheReadTokens ?? null,
        r.cacheWriteTokens ?? null,
        r.costUsd ?? null,
        r.durationMs ?? null,
        r.toolName ?? null,
        r.success ?? null,
        r.raw,
      );
      return `(${Array.from({ length: EVENT_COLUMNS }, (_, c) => `$${at + c + 1}`).join(", ")})`;
    });
    const made = await tx.query(
      `INSERT INTO sesh.events (id, session_id, prompt_id, dedupe_key, kind, occurred_at, model, input_tokens,
         output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, tool_name, success, raw)
       VALUES ${rows.join(", ")}
       ON CONFLICT (session_id, dedupe_key) DO NOTHING RETURNING id`,
      params,
    );
    added += made.length;
  }
  return { added, backfillSkipped, turnsAccepted: accepted.size, turnsSkipped: skipped.size };
}

/** The `session_id\0prompt.id` of each turn in the backfill records that already has at least one stored event. */
async function turnsWithEvents(tx: Tx, orgId: string, records: ParsedRecord[]): Promise<Set<string>> {
  const turns = new Map<string, [string, string]>();
  for (const r of records)
    if (r.backfill && r.promptId) turns.set(`${r.sessionId}\0${r.promptId}`, [r.sessionId, r.promptId]);
  if (!turns.size) return new Set();
  const rows = await tx.query<{ session_id: string; prompt_id: string }>(
    `SELECT DISTINCT s.external_id AS session_id, p.external_id AS prompt_id
     FROM sesh.events e JOIN sesh.prompts p ON p.id = e.prompt_id JOIN sesh.sessions s ON s.id = e.session_id
     WHERE s.org_id = $1 AND s.agent = $2
       AND (s.external_id, p.external_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
    [orgId, AGENT, [...turns.values()].map((t) => t[0]), [...turns.values()].map((t) => t[1])],
  );
  return new Set(rows.map((r) => `${r.session_id}\0${r.prompt_id}`));
}

export interface ParseResult {
  /** Payloads turned into sessions. */
  parsed: number;
  /** Payloads sesh can't read yet (protobuf, or not JSON), marked done so they aren't retried. */
  skipped: number;
  events: number;
  /** Backfill records dropped because their turn was already stored. */
  backfillSkipped: number;
  turnsAccepted: number;
  turnsSkipped: number;
  /** Payloads whose parse threw; left unparsed for the next run. */
  failed: number;
}

/**
 * Parses stored logs payloads that haven't been yet (up to 50, or one by id), oldest first. Each payload is parsed
 * and marked in one transaction; one that throws is counted and left for the next run without blocking the others.
 */
export async function parsePending(db: Db, payloadId?: string): Promise<ParseResult> {
  const rows = await db.query<{
    id: string;
    org_id: string;
    user_id: string;
    content_type: string;
    content_encoding: string | null;
    body: Buffer;
  }>(
    `SELECT id, org_id, user_id, content_type, content_encoding, body FROM sesh.raw_payloads
     WHERE signal = 'logs' AND parsed_at IS NULL AND ($1::uuid IS NULL OR id = $1) ORDER BY id LIMIT 50`,
    [payloadId ?? null],
  );
  const result: ParseResult = {
    parsed: 0,
    skipped: 0,
    events: 0,
    backfillSkipped: 0,
    turnsAccepted: 0,
    turnsSkipped: 0,
    failed: 0,
  };
  for (const row of rows) {
    const json = decodeJsonPayload(row.body, row.content_type, row.content_encoding);
    try {
      await db.transaction(async (tx) => {
        const saved =
          json === undefined
            ? { added: 0, backfillSkipped: 0, turnsAccepted: 0, turnsSkipped: 0 }
            : await saveRecords(tx, row.org_id, row.user_id, parseClaudeCodeLogs(json));
        await tx.query(`UPDATE sesh.raw_payloads SET parsed_at = now() WHERE id = $1`, [row.id]);
        if (json === undefined) result.skipped++;
        else {
          result.parsed++;
          result.events += saved.added;
          result.backfillSkipped += saved.backfillSkipped;
          result.turnsAccepted += saved.turnsAccepted;
          result.turnsSkipped += saved.turnsSkipped;
        }
      });
    } catch (err) {
      console.error(`parse failed for payload ${row.id}:`, err);
      result.failed++;
    }
  }
  return result;
}
