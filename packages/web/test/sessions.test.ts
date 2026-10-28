import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { uuidv7 } from "../src/ids.js";
import { parsePending } from "../src/parse.js";
import { storeRawPayload } from "../src/store.js";
import { type Session, setupApp } from "./harness.js";
import { parseUtcDay, utcDay } from "../src/day.js";

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

describe("today", () => {
  const NOW = new Date("2026-10-27T15:00:00.000Z");

  /** A session in a fresh org, with one prompt and one tool call (100 + 50 tokens) at each of `times`, and what the org sees. */
  async function setup(email: string, startedAt: string, times: string[]) {
    const t = setupApp(db, () => NOW);
    const session = await t.signIn(email);
    const [user] = await db.query<{ id: string }>(`SELECT id FROM sesh.users WHERE email = $1`, [email]);
    const me = (await (await t.call("/me", { session })).json()) as { org: { id: string } };
    const id = uuidv7();
    await db.query(
      `INSERT INTO sesh.sessions (id, org_id, user_id, agent, external_id, started_at, ended_at) VALUES ($1, $2, $3, 'claude-code', $4, $5, $6)`,
      [id, me.org.id, user!.id, id, startedAt, times.at(-1) ?? startedAt],
    );
    for (const [i, at] of times.entries()) {
      await db.query(`INSERT INTO sesh.prompts (id, session_id, external_id, started_at) VALUES ($1, $2, $3, $4)`, [
        uuidv7(),
        id,
        `p${i}`,
        at,
      ]);
      await db.query(
        `INSERT INTO sesh.events (id, session_id, dedupe_key, kind, occurred_at, input_tokens, output_tokens, cache_read_tokens, raw)
         VALUES ($1, $2, $3, 'tool_call', $4, 100, 50, 10, '{}')`,
        [uuidv7(), id, `e${i}`, at],
      );
    }
    return { t, session, id };
  }
  const today = async (x: Awaited<ReturnType<typeof setup>>, query = "") =>
    x.t.call(`/today${query}`, { session: x.session });

  it("counts a session that started yesterday only for what it did today", async () => {
    const x = await setup("yesterday@example.com", "2026-10-26T23:00:00.000Z", [
      "2026-10-26T23:30:00.000Z",
      "2026-10-27T01:00:00.000Z",
    ]);
    const body = (await (await today(x)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ sessions: 1, prompts: 1, tool_calls: 1, tokens: 160, cache_read_tokens: 10 });
    expect(body.top).toMatchObject([{ id: x.id, tokens: 160, prompts: 1, tool_calls: 1 }]);
    const before = (await (await today(x, "?day=2026-10-26")).json()) as Record<string, unknown>;
    expect(before).toMatchObject({ sessions: 1, prompts: 1, tool_calls: 1, tokens: 160 });
  });

  it("does not count a session that started today but did nothing today", async () => {
    // Started at 00:00 UTC today (as the clock sees it) with all its activity the day before.
    const x = await setup("idle@example.com", "2026-10-27T00:00:00.000Z", ["2026-10-26T12:00:00.000Z"]);
    const body = (await (await today(x)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ sessions: 0, prompts: 0, tool_calls: 0, tokens: 0, org_sessions: 1, top: [] });
  });

  it("ends the day at UTC midnight", async () => {
    const x = await setup("edge@example.com", "2026-10-27T00:00:00.000Z", [
      "2026-10-27T00:00:00.000Z",
      "2026-10-28T00:00:00.000Z",
    ]);
    const body = (await (await today(x)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ sessions: 1, prompts: 1 });
  });

  it("rejects a day that is not a date, and records it", async () => {
    const x = await setup("baddate@example.com", "2026-10-27T01:00:00.000Z", ["2026-10-27T01:00:00.000Z"]);
    for (const bad of ["tomorrow", "2026-02-30", "2026-10-27T00:00:00Z"]) {
      const res = await today(x, `?day=${bad}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_day");
    }
    expect(x.t.events.filter((e) => e.event === "today_rejected")).toHaveLength(3);
  });
});

describe("insights activity", () => {
  const NOW = new Date("2026-10-27T15:00:00.000Z");

  it("counts a session on each day it was active, fills missing days with zero, and reports today", async () => {
    const t = setupApp(db, () => NOW);
    const session = await t.signIn("insights@example.com");
    const [user] = await db.query<{ id: string }>(`SELECT id FROM sesh.users WHERE email = 'insights@example.com'`);
    const me = (await (await t.call("/me", { session })).json()) as { org: { id: string } };
    const add = async (at: string[], tools: string[]) => {
      const id = uuidv7();
      await db.query(
        `INSERT INTO sesh.sessions (id, org_id, user_id, agent, external_id, started_at, ended_at) VALUES ($1, $2, $3, 'claude-code', $4, $5, $5)`,
        [id, me.org.id, user!.id, id, at[0] ?? tools[0]],
      );
      for (const [i, a] of at.entries())
        await db.query(`INSERT INTO sesh.prompts (id, session_id, external_id, started_at) VALUES ($1, $2, $3, $4)`, [
          uuidv7(),
          id,
          `p${i}`,
          a,
        ]);
      for (const [i, a] of tools.entries())
        await db.query(
          `INSERT INTO sesh.events (id, session_id, dedupe_key, kind, occurred_at, raw) VALUES ($1, $2, $3, 'tool_call', $4, '{}')`,
          [uuidv7(), id, `e${i}`, a],
        );
    };
    // A: prompts on the 22nd and 27th, tool calls on the 22nd (two), 24th and 27th. B: a prompt and tool call today.
    await add(
      ["2026-10-22T10:00:00.000Z", "2026-10-27T01:00:00.000Z"],
      ["2026-10-22T10:01:00.000Z", "2026-10-22T23:59:59.000Z", "2026-10-24T09:00:00.000Z", "2026-10-27T01:01:00.000Z"],
    );
    await add(["2026-10-27T14:00:00.000Z"], ["2026-10-27T14:01:00.000Z"]);
    // Before the 7 day range: not in it.
    await add(["2026-10-10T10:00:00.000Z"], []);

    const res = await t.call("/insights/activity?days=7", { session });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Record<string, unknown>[]; today: unknown; org_sessions: number };
    expect(body.days.map((d) => d.day)).toEqual([
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
    ]);
    const pick = (d: Record<string, unknown>) => [d.tool_calls, d.prompts, d.active_sessions];
    expect(body.days.map(pick)).toEqual([
      [0, 0, 0],
      [2, 1, 1],
      [0, 0, 0],
      [1, 0, 1],
      [0, 0, 0],
      [0, 0, 0],
      [2, 2, 2],
    ]);
    // Tool calls per prompt: a gap (null) on days with no prompts, else the ratio.
    expect(body.days.map((d) => d.tool_calls_per_prompt)).toEqual([null, 2, null, null, null, null, 1]);
    expect(body.today).toEqual({ tool_calls: 2, prompts: 2, active_sessions: 2, tool_calls_per_prompt: 1 });
    expect(body.org_sessions).toBe(3);
    const wide = (await (await t.call("/insights/activity?days=28", { session })).json()) as typeof body;
    expect(wide.days).toHaveLength(28);
    expect(wide.days.find((d) => d.day === "2026-10-10")).toMatchObject({ prompts: 1, active_sessions: 1 });
    expect(t.events.filter((e) => e.event === "insights_viewed")).toHaveLength(2);
    // By weekday over the 28 days (each weekday four times, zero days counted): Mon had nothing, so no ratio.
    const dow = (wide as unknown as { by_dow: Record<string, unknown>[] }).by_dow;
    expect(dow.map((d) => d.dow)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    const avg = (d: Record<string, unknown>) => [d.tool_calls, d.prompts, d.active_sessions, d.tool_calls_per_prompt];
    expect(dow.map(avg)).toEqual([
      [0, 0, 0, null],
      [0.5, 0.5, 0.5, 1],
      [0, 0, 0, null],
      [0.5, 0.25, 0.25, 2],
      [0, 0, 0, null],
      [0.25, 0.25, 0.5, 1],
      [0, 0, 0, null],
    ]);
    // Over 7 days each weekday is one day, so the average is that day's count.
    const week = (body as unknown as { by_dow: Record<string, unknown>[] }).by_dow;
    expect(week.map(avg)).toEqual([
      [0, 0, 0, null],
      [2, 2, 2, 1],
      [0, 0, 0, null],
      [2, 1, 1, 2],
      [0, 0, 0, null],
      [1, 0, 1, null],
      [0, 0, 0, null],
    ]);
  });

  it("is all zeros for an empty org, and rejects other ranges, recording both", async () => {
    const t = setupApp(db, () => NOW);
    const session = await t.signIn("insights-empty@example.com");
    const body = (await (await t.call("/insights/activity?days=14", { session })).json()) as {
      days: unknown[];
      today: unknown;
      org_sessions: number;
    };
    expect(body.days).toHaveLength(14);
    expect(body.today).toEqual({ tool_calls: 0, prompts: 0, active_sessions: 0, tool_calls_per_prompt: null });
    expect(body.org_sessions).toBe(0);
    expect(t.events.at(-1)).toMatchObject({ event: "insights_viewed", properties: { empty: true, org_empty: true } });
    for (const bad of ["", "?days=", "?days=10", "?days=7.0", "?days=-7"]) {
      const res = await t.call(`/insights/activity${bad}`, { session });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_days");
    }
    expect(t.events.filter((e) => e.event === "insights_rejected")).toHaveLength(5);
  });
});

describe("utcDay", () => {
  it("is the UTC day, whatever the offset", () => {
    expect(utcDay(new Date("2026-10-27T23:59:59.999Z"))).toEqual({
      start: new Date("2026-10-27T00:00:00.000Z"),
      end: new Date("2026-10-28T00:00:00.000Z"),
    });
    expect(parseUtcDay("2026-10-27")?.start).toEqual(new Date("2026-10-27T00:00:00.000Z"));
    expect(parseUtcDay("2026-13-01")).toBeUndefined();
  });
});
