import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { uuidv7 } from "../src/ids.js";
import { parsePending } from "../src/parse.js";
import { storeRawPayload } from "../src/store.js";
import { type Session, setupApp } from "./harness.js";

/** One session: two prompts, two API calls (16 input, 200 output, 20500 cache read, 2500 cache write), two tool calls. */
const fixture = readFileSync(new URL("./fixtures/claude-code-session.json", import.meta.url), "utf8");

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
});
afterAll(async () => {
  await db.close();
});

interface Body {
  page: number;
  total: number;
  sessions: Record<string, unknown>[];
}

/** Signs in and sends the fixture's logs as that user, through their active org. */
async function withSession(t: ReturnType<typeof setupApp>, email: string): Promise<Session> {
  const session = await t.signIn(email);
  const [user] = await db.query<{ id: string }>(`SELECT id FROM sesh.users WHERE email = $1`, [email]);
  const me = (await (await t.call("/me", { session })).json()) as { org: { id: string } };
  await storeRawPayload(db, {
    orgId: me.org.id,
    userId: user!.id,
    signal: "logs",
    contentType: "application/json",
    body: new TextEncoder().encode(fixture),
  });
  await parsePending(db);
  return session;
}

const sessions = async (t: ReturnType<typeof setupApp>, session: Session, query = "") =>
  t.call(`/sessions${query}`, { session });

describe("session list", () => {
  it("lists the org's sessions with figures that match the fixture", async () => {
    const t = setupApp(db);
    const session = await withSession(t, "lister@example.com");
    const res = await sessions(t, session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.total).toBe(1);
    expect(body.sessions[0]).toMatchObject({
      user_name: "lister",
      input_tokens: 16,
      output_tokens: 200,
      cache_read_tokens: 20500,
      cache_write_tokens: 2500,
      prompts: 2,
      tool_calls: 2,
    });
    expect(typeof body.sessions[0]!.started_at).toBe("string");
    expect(t.events.find((e) => e.event === "sessions_viewed")!.properties).toEqual({
      empty: false,
      page_beyond_end: false,
    });
  });

  it("shows only the active org's sessions", async () => {
    const t = setupApp(db);
    await withSession(t, "owner-a@example.com");
    const other = await t.signIn("owner-b@example.com");
    const body = (await (await sessions(t, other)).json()) as Body;
    expect(body).toMatchObject({ total: 0, sessions: [] });
    expect(t.events.find((e) => e.event === "sessions_viewed" && e.properties?.empty)).toBeTruthy();
  });

  it("pages newest first", async () => {
    const t = setupApp(db);
    const session = await t.signIn("pager@example.com");
    const [row] = await db.query<{ org_id: string; user_id: string }>(
      `SELECT m.org_id, m.user_id FROM sesh.org_members m JOIN sesh.users u ON u.id = m.user_id WHERE u.email = $1`,
      ["pager@example.com"],
    );
    for (let i = 0; i < 27; i++)
      await db.query(
        `INSERT INTO sesh.sessions (id, org_id, user_id, agent, external_id, started_at, ended_at)
         VALUES ($1, $2, $3, 'claude-code', $4, '2026-10-01T00:00:00Z'::timestamptz + $5::int * interval '1 minute', now())`,
        [uuidv7(), row!.org_id, row!.user_id, `s${i}`, i],
      );
    const first = (await (await sessions(t, session)).json()) as Body;
    const second = (await (await sessions(t, session, "?page=2")).json()) as Body;
    expect([first.total, first.sessions.length, second.sessions.length]).toEqual([27, 25, 2]);
    const times = [...first.sessions, ...second.sessions].map((s) => Date.parse(s.started_at as string));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const beyond = (await (await sessions(t, session, "?page=3")).json()) as Body;
    expect(beyond.sessions).toEqual([]);
    expect(t.events.at(-1)!.properties).toEqual({ empty: false, page_beyond_end: true });
  });

  it("rejects a bad page and a missing token", async () => {
    const t = setupApp(db);
    const session = await t.signIn("badpage@example.com");
    for (const q of ["?page=0", "?page=-1", "?page=abc", "?page=1.5"])
      expect((await sessions(t, session, q)).status).toBe(400);
    expect(t.events.filter((e) => e.event === "sessions_rejected").length).toBe(4);
    expect((await t.call("/sessions")).status).toBe(401);
  });
});

describe("session detail", () => {
  it("shows a session's prompts and events in order, with raw JSON", async () => {
    const t = setupApp(db);
    const session = await withSession(t, "detail@example.com");
    const list = (await (await sessions(t, session)).json()) as Body;
    const id = list.sessions[0]!.id as string;
    const res = await t.call(`/sessions/${id}`, { session });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: { started_at: string; events: { occurred_at: string; raw: unknown; kind: string }[] }[];
      unattributed_events: unknown[];
    };
    expect(body.prompts.length).toBe(2);
    const events = [
      ...body.prompts.flatMap((p) => p.events),
      ...(body.unattributed_events as { occurred_at: string }[]),
    ];
    expect(events.length).toBe(4);
    for (const p of body.prompts) {
      const times = p.events.map((e) => Date.parse(e.occurred_at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
    expect(body.prompts.flatMap((p) => p.events).every((e) => e.raw && typeof e.raw === "object")).toBe(true);
    expect(t.events.find((e) => e.event === "session_detail_viewed")!.properties).toMatchObject({ prompts: 2 });
  });

  it("returns 404 for another org's session and for ids that don't exist", async () => {
    const t = setupApp(db);
    const owner = await withSession(t, "owner-detail@example.com");
    const id = ((await (await sessions(t, owner)).json()) as Body).sessions[0]!.id as string;
    const other = await t.signIn("other-detail@example.com");
    expect((await t.call(`/sessions/${id}`, { session: other })).status).toBe(404);
    expect((await t.call(`/sessions/${uuidv7()}`, { session: owner })).status).toBe(404);
    expect((await t.call("/sessions/nope", { session: owner })).status).toBe(404);
    expect(t.events.filter((e) => e.event === "session_detail_not_found").length).toBe(3);
    expect((await t.call(`/sessions/${id}`)).status).toBe(401);
  });
});
