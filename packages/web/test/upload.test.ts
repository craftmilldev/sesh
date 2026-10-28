import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPayloads, buildTurns } from "../../cli/sesh.mjs";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { uuidv7 } from "../src/ids.js";
import { parsePending } from "../src/parse.js";
import { storeRawPayload } from "../src/store.js";

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
});
afterAll(async () => {
  await db.close();
});

/** A session as Claude Code's transcript has it: two prompts, three API calls, one tool call. */
const SESSION = "5e5510a0-0000-4000-8000-000000000001";
const at = (s: number) => Date.parse("2026-10-01T10:00:00Z") + s * 1000;
const entries = [
  { type: "user", uuid: "u1", promptId: "pp-1", _at: at(0), message: { content: "SECRET prompt" } },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    _at: at(2),
    message: {
      id: "m1",
      model: "claude-opus-4-5",
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
      content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/secret/path" } }],
    },
  },
  {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    _at: at(3),
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "secret output" }] },
  },
  {
    type: "assistant",
    uuid: "a2",
    parentUuid: "u2",
    _at: at(5),
    message: { id: "m2", model: "claude-opus-4-5", usage: { input_tokens: 1, output_tokens: 2 } },
  },
  { type: "user", uuid: "u3", promptId: "pp-2", _at: at(60), message: { content: "second prompt" } },
  {
    type: "assistant",
    uuid: "a3",
    parentUuid: "u3",
    _at: at(62),
    message: { id: "m3", model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 6 } },
  },
];

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
const send = (w: { orgId: string; userId: string }, payload: unknown) =>
  storeRawPayload(db, {
    ...w,
    signal: "logs",
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });
const totals = async (orgId: string) =>
  (
    await db.query<{ sessions: string; prompts: string; events: string; input: string; output: string }>(
      `SELECT (SELECT count(*) FROM sesh.sessions WHERE org_id = $1) AS sessions,
              (SELECT count(*) FROM sesh.prompts p JOIN sesh.sessions s ON s.id = p.session_id WHERE s.org_id = $1) AS prompts,
              (SELECT count(*) FROM sesh.events e JOIN sesh.sessions s ON s.id = e.session_id WHERE s.org_id = $1) AS events,
              (SELECT coalesce(sum(input_tokens), 0) FROM sesh.events e JOIN sesh.sessions s ON s.id = e.session_id WHERE s.org_id = $1) AS input,
              (SELECT coalesce(sum(output_tokens), 0) FROM sesh.events e JOIN sesh.sessions s ON s.id = e.session_id WHERE s.org_id = $1) AS output`,
      [orgId],
    )
  ).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])))[0];

describe("sesh upload against ingest", () => {
  const { payloads } = buildPayloads(buildTurns(entries, SESSION), SESSION);

  it("creates the session, prompts and events with the right counts and tokens", async () => {
    const w = await member("up1");
    for (const p of payloads) await send(w, p);
    await parsePending(db);
    expect(await totals(w.orgId)).toEqual({ sessions: 1, prompts: 2, events: 4, input: 16, output: 28 });
    expect(JSON.stringify(payloads)).not.toMatch(/SECRET|secret|second prompt/);
  });

  it("adds nothing the second time", async () => {
    const w = await member("up2");
    for (const p of payloads) await send(w, p);
    await parsePending(db);
    const before = await totals(w.orgId);
    for (const p of payloads) await send(w, p);
    await parsePending(db);
    expect(await totals(w.orgId)).toEqual(before);
  });

  it("does not duplicate a turn live ingest already stored", async () => {
    const w = await member("up3");
    // Live: the first prompt's turn, with one API call, under the same prompt id.
    const attr = (key: string, value: Record<string, unknown>) => ({ key, value });
    const live = (name: string, extra: ReturnType<typeof attr>[]) => ({
      timeUnixNano: String(at(1) * 1e6),
      attributes: [
        attr("event.name", { stringValue: name }),
        attr("session.id", { stringValue: SESSION }),
        attr("prompt.id", { stringValue: "pp-1" }),
        attr("event.sequence", { intValue: "1" }),
        ...extra,
      ],
    });
    await send(w, {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                live("user_prompt", []),
                live("api_request", [
                  attr("input_tokens", { intValue: "10" }),
                  attr("output_tokens", { intValue: "20" }),
                ]),
              ],
            },
          ],
        },
      ],
    });
    await parsePending(db);
    expect((await totals(w.orgId))!.events).toBe(1);
    for (const p of payloads) await send(w, p);
    await parsePending(db);
    // Only the second turn (prompt, one API call) is new.
    expect(await totals(w.orgId)).toMatchObject({ prompts: 2, events: 2 });
  });
});
