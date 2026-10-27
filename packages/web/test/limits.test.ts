import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { parsePending } from "../src/parse.js";
import {
  expectedUsed,
  planPool,
  poolPace,
  poolUsed,
  storeLimitSnapshot,
  storeRawPayload,
  weekdayMs,
} from "../src/store.js";
import { uuidv7 } from "../src/ids.js";
import { type Session, setupApp } from "./harness.js";

const logs = readFileSync(new URL("./fixtures/claude-code-session.json", import.meta.url), "utf8");

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
});
afterAll(async () => {
  await db.close();
});

const future = Math.floor(Date.now() / 1000) + 3600;
const snapshot = (extra: Record<string, unknown> = {}) => ({
  session_id: "sess-1",
  five_hour_pct: 19,
  five_hour_resets_at: future,
  seven_day_pct: 8,
  seven_day_resets_at: future + 86400,
  captured_at: new Date().toISOString(),
  ...extra,
});

describe("POST /v1/limits", () => {
  async function setup(email: string) {
    const t = setupApp(db);
    const session: Session = await t.signIn(email);
    const res = await t.call("/tokens", { body: { name: "t" }, session });
    const token = ((await res.json()) as { token: string }).token;
    const me = (await (await t.call("/me", { session })).json()) as { org: { id: string } };
    const [user] = await db.query<{ id: string }>(`SELECT id FROM sesh.users WHERE email = $1`, [email]);
    const post = (body: unknown, auth: string | null = `Bearer ${token}`) =>
      t.app.request("/v1/limits", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    return { ...t, session, token, orgId: me.org.id, userId: user!.id, post };
  }
  const stored = (userId: string) =>
    db.query<Record<string, unknown>>(`SELECT * FROM sesh.limit_snapshots WHERE user_id = $1 ORDER BY captured_at`, [
      userId,
    ]);

  it("stores a snapshot for the token's org and user, and nothing else from the body", async () => {
    const t = await setup("lim1@example.com");
    const res = await t.post(snapshot({ prompt: "secret text", email: "x@y.z" }));
    expect(res.status).toBe(200);
    const rows = await stored(t.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: t.orgId,
      user_id: t.userId,
      session_external_id: "sess-1",
      five_hour_pct: 19,
      seven_day_pct: 8,
    });
    expect(JSON.stringify(rows[0])).not.toContain("secret");
    expect(t.events.find((e) => e.event === "limits_accepted")!.properties).toEqual({
      has_five_hour: true,
      has_seven_day: true,
    });
  });

  it("answers 401 to a missing or bad token and stores nothing", async () => {
    const t = await setup("lim2@example.com");
    expect((await t.post(snapshot(), null)).status).toBe(401);
    expect((await t.post(snapshot(), "Bearer nope")).status).toBe(401);
    expect(await stored(t.userId)).toHaveLength(0);
    expect(t.events.filter((e) => e.event === "limits_rejected").map((e) => e.properties?.reason)).toEqual([
      "missing_token",
      "invalid_token",
    ]);
  });

  it("rejects bad bodies with a reason", async () => {
    const t = await setup("lim3@example.com");
    const cases: [unknown, string][] = [
      ["not json", "invalid_session_id"],
      [snapshot({ session_id: "" }), "invalid_session_id"],
      [snapshot({ five_hour_pct: 120 }), "invalid_value"],
      [snapshot({ seven_day_pct: "8" }), "invalid_value"],
      [snapshot({ five_hour_resets_at: -5 }), "invalid_value"],
      [snapshot({ five_hour_pct: null, seven_day_pct: null }), "no_percentages"],
      [snapshot({ captured_at: "yesterday-ish" }), "invalid_captured_at"],
      [snapshot({ captured_at: new Date(Date.now() + 3 * 86400_000).toISOString() }), "invalid_captured_at"],
    ];
    for (const [body, reason] of cases) {
      const res = await t.post(body);
      expect(res.status, reason).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(reason);
    }
    expect(await stored(t.userId)).toHaveLength(0);
  });

  it("accepts one window alone", async () => {
    const t = await setup("lim4@example.com");
    const res = await t.post(snapshot({ seven_day_pct: null, seven_day_resets_at: null }));
    expect(res.status).toBe(200);
    expect((await stored(t.userId))[0]).toMatchObject({ five_hour_pct: 19, seven_day_pct: null });
  });

  it("shows the latest reading on the session list, and a dash (null) for a session with none", async () => {
    const t = await setup("lim5@example.com");
    await storeRawPayload(db, {
      orgId: t.orgId,
      userId: t.userId,
      signal: "logs",
      contentType: "application/json",
      body: new TextEncoder().encode(logs),
    });
    await parsePending(db);
    const list = async () =>
      ((await (await t.call("/sessions", { session: t.session })).json()) as { sessions: Record<string, unknown>[] })
        .sessions;
    expect((await list())[0]).toMatchObject({ five_hour_pct: null, seven_day_pct: null });

    const [s] = await db.query<{ external_id: string }>(`SELECT external_id FROM sesh.sessions WHERE user_id = $1`, [
      t.userId,
    ]);
    const id = s!.external_id;
    const at = (ms: number) => new Date(Date.now() - ms).toISOString();
    await t.post(snapshot({ session_id: id, five_hour_pct: 10, seven_day_pct: 3, captured_at: at(120_000) }));
    await t.post(snapshot({ session_id: id, five_hour_pct: 0, seven_day_pct: 4, captured_at: at(60_000) }));
    expect((await list())[0]).toMatchObject({ five_hour_pct: 0, seven_day_pct: 4 });

    // The pool takes each window's highest reading, since usage only rises until the window resets.
    const pool = (await (await t.call("/limits", { session: t.session })).json()) as Record<string, unknown>;
    expect(pool).toMatchObject({
      members: 1,
      five_hour_used: 10,
      seven_day_used: 4,
      five_hour_reporting: 1,
      seven_day_reporting: 1,
    });
  });

  it("treats a window past its reset time as unknown in the current view", async () => {
    const t = await setup("lim6@example.com");
    await t.post(snapshot({ five_hour_resets_at: Math.floor(Date.now() / 1000) - 60 }));
    const pool = (await (await t.call("/limits", { session: t.session })).json()) as Record<string, unknown>;
    expect(pool).toMatchObject({
      five_hour_used: 0,
      five_hour_reporting: 0,
      seven_day_used: 8,
      seven_day_reporting: 1,
    });
  });

  it("only shows the active org's readings", async () => {
    const a = await setup("lim7@example.com");
    const b = await setup("lim8@example.com");
    await a.post(snapshot());
    const res = (await (await b.call("/limits", { session: b.session })).json()) as Record<string, unknown>;
    expect(res).toMatchObject({ five_hour_reporting: 0, seven_day_reporting: 0, five_hour_used: 0 });
  });
});

describe("the team plan pool", () => {
  it("is the members' average used share, rounded", () => {
    expect(poolUsed([25, 50], 4)).toBe(19); // 4 members, two with no reading
    expect(poolUsed([], 3)).toBe(0); // nobody reported
    expect(poolUsed([100, 100], 2)).toBe(100);
    expect(poolUsed([33], 3)).toBe(11);
    expect(poolUsed([150, -5], 2)).toBe(50); // readings are clamped to 0-100
    expect(poolUsed([40], 0)).toBe(0);
  });

  it("counts every member, those with no reading and those whose window has reset as unused", async () => {
    const t = setupApp(db);
    const session = await t.signIn("pool1@example.com");
    const me = (await (await t.call("/me", { session })).json()) as { org: { id: string } };
    const orgId = me.org.id;
    const member = async (name: string) => {
      const id = uuidv7();
      await db.query(`INSERT INTO sesh.users (id, name, email) VALUES ($1, $2, $3)`, [id, name, `${name}@example.com`]);
      await db.query(
        `INSERT INTO sesh.org_members (org_id, user_id, role, counts_toward_team) VALUES ($1, $2, 'member', true)`,
        [orgId, id],
      );
      return id;
    };
    const [owner] = await db.query<{ id: string }>(`SELECT id FROM sesh.users WHERE email = $1`, ["pool1@example.com"]);
    const a = owner!.id;
    const b = await member("pool1b");
    await member("pool1c"); // never reports
    const d = await member("pool1d"); // reported, but the window has passed
    const soon = new Date(Date.now() + 3600_000);
    const read = (userId: string, five: number, resets: Date) =>
      storeLimitSnapshot(
        db,
        { orgId, userId },
        {
          sessionId: userId,
          fiveHourPct: five,
          fiveHourResetsAt: resets,
          sevenDayPct: five / 2,
          sevenDayResetsAt: soon,
          capturedAt: new Date(),
        },
      );
    await read(a, 25, soon);
    await read(b, 50, soon);
    await read(d, 90, new Date(Date.now() - 60_000));

    expect(await planPool(db, orgId)).toMatchObject({
      members: 4,
      five_hour_used: 19, // (25 + 50) / 4, rounded
      seven_day_used: 21, // (12.5 + 25 + 45) / 4, rounded
      five_hour_reporting: 2,
      seven_day_reporting: 3,
    });
  });
});

describe("the team's 7 day pace", () => {
  const H = 3600_000;
  // A window that resets Wednesday 13:00 UTC, so it opened Wednesday 2026-10-21 13:00.
  const wednesday = new Date("2026-10-28T13:00:00Z");

  it("counts weekday time only, in UTC", () => {
    expect(weekdayMs(new Date("2026-10-23T20:00:00Z"), new Date("2026-10-26T02:00:00Z"))).toBe(6 * H); // Fri 20:00 to Mon 02:00
    expect(weekdayMs(new Date("2026-10-24T00:00:00Z"), new Date("2026-10-26T00:00:00Z"))).toBe(0);
    expect(weekdayMs(new Date("2026-10-19T00:00:00Z"), new Date("2026-10-26T00:00:00Z"))).toBe(120 * H);
  });

  it("expects 20% a weekday and nothing on the weekend", () => {
    expect(expectedUsed(wednesday, new Date("2026-10-21T13:00:00Z"))).toBe(0);
    expect(expectedUsed(wednesday, new Date("2026-10-22T13:00:00Z"))).toBe(20);
    expect(expectedUsed(wednesday, new Date("2026-10-23T22:00:00Z"))).toBe(47.5); // Friday 22:00: 57 of 120 hours
    const saturday = expectedUsed(wednesday, new Date("2026-10-24T00:00:00Z")); // 59 of 120 hours
    expect(expectedUsed(wednesday, new Date("2026-10-25T23:59:00Z"))).toBe(saturday); // flat over the weekend
    expect(saturday).toBeCloseTo(49.17, 2);
    expect(expectedUsed(wednesday, new Date("2026-10-27T13:00:00Z"))).toBe(80);
    expect(expectedUsed(wednesday, wednesday)).toBe(100);
    // A window that opens on Saturday expects nothing until Monday.
    expect(expectedUsed(new Date("2026-10-31T16:00:00Z"), new Date("2026-10-25T20:00:00Z"))).toBe(0);
  });

  it("is the pool's usage against that even pace, and null when nothing is expected yet", () => {
    const friday = new Date("2026-10-23T22:00:00Z"); // 47.5% expected of the Wednesday window
    expect(poolPace([{ used: 34, resetsAt: wednesday }], 1, friday)).toEqual({
      seven_day_expected: 48,
      seven_day_pace: 72,
    });
    expect(poolPace([{ used: 47.5, resetsAt: wednesday }], 2, friday)).toEqual({
      seven_day_expected: 24,
      seven_day_pace: 100,
    });
    expect(poolPace([{ used: 0, resetsAt: new Date("2026-10-31T16:00:00Z") }], 1, friday)).toEqual({
      seven_day_expected: 0,
      seven_day_pace: null,
    });
    expect(poolPace([], 0, friday)).toEqual({ seven_day_expected: 0, seven_day_pace: null });
  });

  it("takes a window's highest reading over idle sessions that keep posting old ones, and rolls a reset window forward", async () => {
    const t = setupApp(db);
    const session = await t.signIn("pace1@example.com");
    const me = (await (await t.call("/me", { session })).json()) as { org: { id: string } };
    const orgId = me.org.id;
    const [owner] = await db.query<{ id: string }>(`SELECT id FROM sesh.users WHERE email = $1`, ["pace1@example.com"]);
    const other = uuidv7();
    await db.query(`INSERT INTO sesh.users (id, name, email) VALUES ($1, 'pace1b', 'pace1b@example.com')`, [other]);
    await db.query(
      `INSERT INTO sesh.org_members (org_id, user_id, role, counts_toward_team) VALUES ($1, $2, 'member', true)`,
      [orgId, other],
    );
    const read = (userId: string, sessionId: string, pct: number, resets: string, at: string) =>
      storeLimitSnapshot(
        db,
        { orgId, userId },
        {
          sessionId,
          fiveHourPct: null,
          fiveHourResetsAt: null,
          sevenDayPct: pct,
          sevenDayResetsAt: new Date(resets),
          capturedAt: new Date(at),
        },
      );
    // The owner's busy session reached 34%; an idle one keeps posting the 11% it saw first, and posted last.
    await read(owner!.id, "busy", 34, "2026-10-28T13:00:00Z", "2026-10-23T18:00:00Z");
    await read(owner!.id, "idle", 11, "2026-10-28T13:00:00Z", "2026-10-25T18:00:00Z");
    // The other member's window reset Saturday 16:00 and they haven't reported since: a new window, 0% used.
    await read(other, "old", 18, "2026-10-24T16:00:00Z", "2026-10-23T21:00:00Z");

    const now = new Date("2026-10-26T03:00:00Z"); // Monday 03:00 UTC: 62 of the owner's 120 weekday hours, 3 of the other's
    const pool = await planPool(db, orgId, now);
    expect(pool).toEqual({
      members: 2,
      five_hour_used: 0,
      seven_day_used: 17, // 34 / 2
      five_hour_reporting: 0,
      seven_day_reporting: 1,
      seven_day_expected: 27, // (51.67 + 2.5) / 2
      seven_day_pace: 63, // 34 / 54.17
    });
  });
});

describe("plan usage over OTLP metrics", () => {
  async function setup(email: string) {
    const t = setupApp(db);
    const session: Session = await t.signIn(email);
    const res = await t.call("/tokens", { body: { name: "t" }, session });
    const token = ((await res.json()) as { token: string }).token;
    const [user] = await db.query<{ id: string }>(`SELECT id FROM sesh.users WHERE email = $1`, [email]);
    const post = (body: unknown) =>
      t.app.request("/v1/metrics", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    return { ...t, session, userId: user!.id, post };
  }
  const at = String(Date.now() * 1_000_000);
  const point = (window: string, value: number, session: string | null = "otlp-sess") => ({
    asDouble: value,
    timeUnixNano: at,
    attributes: [
      { key: "plan.window", value: { stringValue: window } },
      { key: "plan.resets_at", value: { intValue: String(future) } },
      ...(session ? [{ key: "session.id", value: { stringValue: session } }] : []),
    ],
  });
  const body = (points: unknown[], name = "plan.usage.utilization") => ({
    resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name, unit: "1", gauge: { dataPoints: points } }] }] }],
  });
  const snapshots = (userId: string) =>
    db.query(`SELECT five_hour_pct, seven_day_pct, session_external_id FROM sesh.limit_snapshots WHERE user_id = $1`, [
      userId,
    ]);

  it("stores a gauge reading as a limit snapshot, as percentages", async () => {
    const t = await setup("otlp1@example.com");
    const res = await t.post(body([point("5h", 0.25), point("7d", 0.5), point("seven_day_opus", 0.9)]));
    expect(res.status).toBe(200);
    expect(await snapshots(t.userId)).toEqual([
      { five_hour_pct: 25, seven_day_pct: 50, session_external_id: "otlp-sess" },
    ]);
    const pool = (await (await t.call("/limits", { session: t.session })).json()) as Record<string, unknown>;
    expect(pool).toMatchObject({ five_hour_used: 25, seven_day_used: 50 });
  });

  it("ignores other metrics, out-of-range values and points without a session", async () => {
    const t = await setup("otlp2@example.com");
    await t.post(body([point("5h", 0.1)], "something.else"));
    await t.post(body([point("5h", 1.5), point("7d", 0.2, null)]));
    expect(await snapshots(t.userId)).toEqual([]);
  });
});
