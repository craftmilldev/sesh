import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { parsePending } from "../src/parse.js";
import { storeRawPayload } from "../src/store.js";
import { formatBar, parseInput, reportable } from "../statusline/sesh-statusline.js";
import { type Session, setupApp } from "./harness.js";

const input = readFileSync(new URL("./fixtures/statusline-input.json", import.meta.url), "utf8");
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

describe("status line script", () => {
  it("keeps only the session id and limits from the captured input", () => {
    const s = parseInput(input, new Date("2026-10-22T00:00:00Z"));
    expect(s).toEqual({
      session_id: "0f6c2f0e-3b2a-4a55-9d0e-6a7c0a1b2c3d",
      five_hour_pct: 19,
      five_hour_resets_at: 1792000000,
      seven_day_pct: 8,
      seven_day_resets_at: 1792400000,
      captured_at: "2026-10-22T00:00:00.000Z",
    });
    expect(formatBar(s)).toBe("5h 19% | 7d 8%");
    expect(reportable(s)).toBe(true);
  });

  it("handles input without limits or that is not JSON", () => {
    const none = parseInput('{"session_id":"x"}');
    expect(formatBar(none)).toBe("5h n/a | 7d n/a");
    expect(reportable(none)).toBe(false);
    expect(parseInput("not json")).toBeNull();
    expect(formatBar(null)).toBe("5h n/a | 7d n/a");
    expect(reportable(null)).toBe(false);
  });
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

    const limits = (await (await t.call("/limits", { session: t.session })).json()) as {
      limits: { user_name: string; five_hour_pct: number | null; seven_day_pct: number | null }[];
    };
    expect(limits.limits).toEqual([expect.objectContaining({ user_name: "lim5", five_hour_pct: 0, seven_day_pct: 4 })]);
  });

  it("treats a window past its reset time as unknown in the current view", async () => {
    const t = await setup("lim6@example.com");
    await t.post(snapshot({ five_hour_resets_at: Math.floor(Date.now() / 1000) - 60 }));
    const limits = (await (await t.call("/limits", { session: t.session })).json()) as {
      limits: { five_hour_pct: number | null; seven_day_pct: number | null }[];
    };
    expect(limits.limits[0]).toMatchObject({ five_hour_pct: null, seven_day_pct: 8 });
  });

  it("only shows the active org's readings", async () => {
    const a = await setup("lim7@example.com");
    const b = await setup("lim8@example.com");
    await a.post(snapshot());
    const res = (await (await b.call("/limits", { session: b.session })).json()) as { limits: unknown[] };
    expect(res.limits).toEqual([]);
  });
});
