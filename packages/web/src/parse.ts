import type { Db } from "./db/index.js";
import { decodeJsonPayload, parseClaudeCodeLogs, type ParsedRecord } from "./claude-code.js";
import { uuidv7 } from "./ids.js";

type Tx = Pick<Db, "query">;

const AGENT = "claude-code";

/**
 * Writes parsed records for one org and user. Safe to run twice on the same records, and in any order:
 * a session, a prompt and an event are each found-or-created by their own ids, a session's span only widens,
 * and an event that arrives before its prompt's `user_prompt` makes the prompt, which the later one fills in.
 */
export async function saveRecords(tx: Tx, orgId: string, userId: string, records: ParsedRecord[]): Promise<number> {
  let added = 0;
  const sessions = new Map<string, string>();
  for (const r of records) {
    let sessionId = sessions.get(r.sessionId);
    if (!sessionId) {
      const [s] = await tx.query<{ id: string }>(
        `INSERT INTO sesh.sessions (id, org_id, user_id, agent, external_id, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (org_id, agent, external_id) DO UPDATE
           SET started_at = LEAST(sesh.sessions.started_at, $6), ended_at = GREATEST(sesh.sessions.ended_at, $6)
         RETURNING id`,
        [uuidv7(), orgId, userId, AGENT, r.sessionId, r.at],
      );
      sessionId = s!.id;
      sessions.set(r.sessionId, sessionId);
    } else {
      await tx.query(
        `UPDATE sesh.sessions SET started_at = LEAST(started_at, $2), ended_at = GREATEST(ended_at, $2) WHERE id = $1`,
        [sessionId, r.at],
      );
    }

    let promptId: string | undefined;
    if (r.promptId) {
      const length = r.type === "prompt" ? (r.promptLength ?? null) : null;
      const [p] = await tx.query<{ id: string }>(
        `INSERT INTO sesh.prompts (id, session_id, external_id, prompt_length, started_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id, external_id) DO UPDATE
           SET started_at = LEAST(sesh.prompts.started_at, $5),
               prompt_length = COALESCE(sesh.prompts.prompt_length, $4)
         RETURNING id`,
        [uuidv7(), sessionId, r.promptId, length, r.at],
      );
      promptId = p!.id;
    }

    if (r.type === "event") {
      const made = await tx.query(
        `INSERT INTO sesh.events (id, session_id, prompt_id, dedupe_key, kind, occurred_at, model, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, tool_name, success, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (session_id, dedupe_key) DO NOTHING RETURNING id`,
        [
          uuidv7(),
          sessionId,
          promptId ?? null,
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
        ],
      );
      added += made.length;
    }
  }
  return added;
}

export interface ParseResult {
  /** Payloads turned into sessions. */
  parsed: number;
  /** Payloads sesh can't read yet (protobuf, or not JSON), marked done so they aren't retried. */
  skipped: number;
  events: number;
}

/**
 * Parses stored logs payloads that haven't been yet (all of them, or one by id), oldest first. Each payload is parsed
 * and marked in one transaction, so a failure leaves it for the next run.
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
     WHERE signal = 'logs' AND parsed_at IS NULL AND ($1::uuid IS NULL OR id = $1) ORDER BY id`,
    [payloadId ?? null],
  );
  const result: ParseResult = { parsed: 0, skipped: 0, events: 0 };
  for (const row of rows) {
    const json = decodeJsonPayload(row.body, row.content_type, row.content_encoding);
    await db.transaction(async (tx) => {
      if (json === undefined) {
        result.skipped++;
      } else {
        result.events += await saveRecords(tx, row.org_id, row.user_id, parseClaudeCodeLogs(json));
        result.parsed++;
      }
      await tx.query(`UPDATE sesh.raw_payloads SET parsed_at = now() WHERE id = $1`, [row.id]);
    });
  }
  return result;
}
