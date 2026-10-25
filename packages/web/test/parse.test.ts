import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseClaudeCodeLogs } from "../src/claude-code.js";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { uuidv7 } from "../src/ids.js";
import { parsePending, saveRecords } from "../src/parse.js";
import { storeRawPayload } from "../src/store.js";

/** The shape of a Claude Code OTLP/JSON logs export for one session: two prompts, two API calls, two tool calls. */
const fixture = readFileSync(new URL("./fixtures/claude-code-session.json", import.meta.url), "utf8");
type FixtureDoc = { resourceLogs: { scopeLogs: { logRecords: { attributes: unknown[] }[] }[] }[] };
const SESSION = "7c1f0a52-1111-4e0d-9a10-aaaaaaaaaaaa";

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
});
afterAll(async () => {
  await db.close();
});

async function member(tag: string) {
  const userId = uuidv7();
  const orgId = uuidv7();
  await db.query(`INSERT INTO sesh.users (id, name, email) VALUES ($1, $2, $3)`, [userId, tag, `${tag}@example.com`]);
  await db.query(`INSERT INTO sesh.orgs (id, name) VALUES ($1, $2)`, [orgId, tag]);
  await db.query(
    `INSERT INTO sesh.org_members (org_id, user_id, role, counts_toward_team) VALUES ($1, $2, 'owner', true)`,
    [orgId, userId],
  );
  return { userId, orgId };
}
const store = (w: { orgId: string; userId: string }, body: string | Uint8Array, extra = {}) =>
  storeRawPayload(db, {
    ...w,
    signal: "logs",
    contentType: "application/json",
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    ...extra,
  });
const n = async (sql: string, p: unknown[]) => Number((await db.query<{ n: string }>(sql, p))[0]!.n);

describe("claude code adapter", () => {
  it("reads prompts and events and drops what it doesn't know", () => {
    const records = parseClaudeCodeLogs(JSON.parse(fixture));
    expect(records.map((r) => (r.type === "event" ? r.kind : r.type))).toEqual([
      "prompt",
      "api_request",
      "tool_call",
      "api_request",
      "prompt",
      "tool_call",
    ]);
    expect(records[0]).toMatchObject({ sessionId: SESSION, promptId: "p-1111", promptLength: 31 });
    expect(records[1]).toMatchObject({
      model: "claude-opus-4-5",
      inputTokens: 12,
      outputTokens: 140,
      cacheReadTokens: 9000,
      cacheWriteTokens: 2500,
      costUsd: 0.0731,
      durationMs: 3100,
    });
    expect(records[2]).toMatchObject({ toolName: "Edit", success: true });
    expect(records[5]).toMatchObject({ toolName: "Bash", success: false });
  });

  it("never carries prompt text or identity", () => {
    const out = JSON.stringify(parseClaudeCodeLogs(JSON.parse(fixture)));
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("dev@example.com");
    expect(out).not.toContain("acct-uuid");
  });
});

describe("parsing stored payloads", () => {
  it("turns a session into sessions, prompts and events for the token's org and user", async () => {
    const w = await member("par1");
    await store(w, fixture);
    expect(await parsePending(db)).toMatchObject({ parsed: 1, events: 4 });
    const [s] = await db.query<{ user_id: string; agent: string; started_at: Date; ended_at: Date }>(
      `SELECT * FROM sesh.sessions WHERE org_id = $1`,
      [w.orgId],
    );
    expect(s).toMatchObject({ user_id: w.userId, agent: "claude-code" });
    expect(s!.started_at.toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(s!.ended_at.toISOString()).toBe("2026-10-20T15:02:04.000Z");
    const prompts = await db.query<{ external_id: string; prompt_length: number; events: string }>(
      `SELECT p.external_id, p.prompt_length, (SELECT count(*) FROM sesh.events e WHERE e.prompt_id = p.id) AS events
       FROM sesh.prompts p JOIN sesh.sessions s ON s.id = p.session_id WHERE s.org_id = $1 ORDER BY p.started_at`,
      [w.orgId],
    );
    expect(prompts.map((p) => [p.external_id, p.prompt_length, Number(p.events)])).toEqual([
      ["p-1111", 31, 3],
      ["p-2222", 9, 1],
    ]);
    const [tot] = await db.query<{ input: string; cost: number }>(
      `SELECT sum(e.input_tokens) AS input, sum(e.cost_usd) AS cost FROM sesh.events e
       JOIN sesh.sessions s ON s.id = e.session_id WHERE s.org_id = $1 AND e.kind = 'api_request'`,
      [w.orgId],
    );
    expect(Number(tot!.input)).toBe(16);
    expect(tot!.cost).toBeCloseTo(0.0943);
  });

  it("creates no duplicates when the same payload is processed again, or sent twice", async () => {
    const w = await member("par2");
    const id = await store(w, fixture);
    await parsePending(db);
    await db.query(`UPDATE sesh.raw_payloads SET parsed_at = NULL WHERE id = $1`, [id]);
    expect((await parsePending(db)).events).toBe(0);
    await store(w, fixture);
    expect((await parsePending(db)).events).toBe(0);
    const counts = [
      `SELECT count(*) AS n FROM sesh.sessions WHERE org_id = $1`,
      `SELECT count(*) AS n FROM sesh.prompts p JOIN sesh.sessions s ON s.id = p.session_id WHERE s.org_id = $1`,
      `SELECT count(*) AS n FROM sesh.events e JOIN sesh.sessions s ON s.id = e.session_id WHERE s.org_id = $1`,
    ];
    expect(await Promise.all(counts.map((q) => n(q, [w.orgId])))).toEqual([1, 2, 4]);
  });

  it("stores no prompt text anywhere", async () => {
    const w = await member("par3");
    await store(w, fixture);
    await parsePending(db);
    const dump = await db.query<{ t: string }>(
      `SELECT row_to_json(e)::text AS t FROM sesh.events e JOIN sesh.sessions s ON s.id = e.session_id WHERE s.org_id = $1
       UNION ALL SELECT row_to_json(p)::text FROM sesh.prompts p JOIN sesh.sessions s ON s.id = p.session_id WHERE s.org_id = $1
       UNION ALL SELECT row_to_json(s)::text FROM sesh.sessions s WHERE s.org_id = $1`,
      [w.orgId],
    );
    expect(dump.length).toBeGreaterThan(5);
    expect(dump.map((d) => d.t).join("\n")).not.toMatch(/SECRET|dev@example\.com|acct-uuid/);
  });

  it("attaches late and out-of-order events to the right session and prompt", async () => {
    const w = await member("par4");
    const all = parseClaudeCodeLogs(JSON.parse(fixture));
    // Events first, the prompt that started them last, in reverse time order.
    await db.transaction((tx) => saveRecords(tx, w.orgId, w.userId, [...all].reverse()));
    const [s] = await db.query<{ started_at: Date; ended_at: Date }>(`SELECT * FROM sesh.sessions WHERE org_id = $1`, [
      w.orgId,
    ]);
    expect(s!.started_at.toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(s!.ended_at.toISOString()).toBe("2026-10-20T15:02:04.000Z");
    const prompts = await db.query<{ external_id: string; prompt_length: number; started_at: Date }>(
      `SELECT p.* FROM sesh.prompts p JOIN sesh.sessions s ON s.id = p.session_id WHERE s.org_id = $1 ORDER BY p.external_id`,
      [w.orgId],
    );
    expect(prompts.map((p) => [p.external_id, p.prompt_length, p.started_at.toISOString()])).toEqual([
      ["p-1111", 31, "2026-10-20T15:00:00.000Z"],
      ["p-2222", 9, "2026-10-20T15:02:00.000Z"],
    ]);
    expect(await n(`SELECT count(*) AS n FROM sesh.events WHERE prompt_id IS NULL`, [])).toBe(0);
  });

  it("keeps tool parameters and error text out of the raw JSON", () => {
    const doc = JSON.parse(fixture) as FixtureDoc;
    doc.resourceLogs[0]!.scopeLogs[0]!.logRecords[2]!.attributes.push(
      { key: "tool_parameters", value: { stringValue: "rm -rf /secret" } },
      { key: "error", value: { stringValue: "token abc123 rejected" } },
    );
    expect(JSON.stringify(parseClaudeCodeLogs(doc))).not.toMatch(/secret|abc123/);
  });

  it("strips NULs and retries a payload that failed, without blocking the rest", async () => {
    const w = await member("par7");
    const doc = JSON.parse(fixture) as FixtureDoc;
    doc.resourceLogs[0]!.scopeLogs[0]!.logRecords[1]!.attributes.push({
      key: "model",
      value: { stringValue: "a\u0000b" },
    });
    await store(w, JSON.stringify(doc));
    expect(await parsePending(db)).toMatchObject({ parsed: 1, failed: 0 });
    const [bad] = await db.query<{ id: string }>(
      `INSERT INTO sesh.raw_payloads (id, org_id, user_id, signal, content_type, body)
       VALUES ($1, $2, $3, 'logs', 'application/json', $4) RETURNING id`,
      [uuidv7(), w.orgId, w.userId, Buffer.from('{"resourceLogs":[{"scopeLogs":[{"logRecords":[null]}]}]}')],
    );
    await store(w, fixture.replace(SESSION, "other-session"));
    expect(await parsePending(db)).toMatchObject({ parsed: 1, failed: 1 });
    expect(await n(`SELECT count(*) AS n FROM sesh.raw_payloads WHERE id = $1 AND parsed_at IS NULL`, [bad!.id])).toBe(
      1,
    );
  });

  it("keeps the same session id in two orgs apart", async () => {
    const a = await member("par5a");
    const b = await member("par5b");
    await store(a, fixture);
    await store(b, fixture);
    await parsePending(db);
    expect(await n(`SELECT count(*) AS n FROM sesh.sessions WHERE org_id IN ($1, $2)`, [a.orgId, b.orgId])).toBe(2);
  });

  it("reads gzipped payloads and marks protobuf ones skipped", async () => {
    const w = await member("par6");
    await store(w, gzipSync(fixture), { contentEncoding: "gzip" });
    await store(w, Uint8Array.from([0x0a, 0x00]), { contentType: "application/x-protobuf" });
    expect(await parsePending(db)).toMatchObject({ parsed: 1, skipped: 1, events: 4 });
    expect(
      await n(`SELECT count(*) AS n FROM sesh.raw_payloads WHERE org_id = $1 AND parsed_at IS NULL`, [w.orgId]),
    ).toBe(0);
  });
});
