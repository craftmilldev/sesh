import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import type { Email } from "../src/email.js";
import type { Metrics } from "../src/metrics.js";

const SECRET = "test-secret";

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
});
afterAll(async () => {
  await db.close();
});

function setup() {
  const events: { event: string; distinctId: string; properties?: Record<string, unknown> }[] = [];
  const emails: Email[] = [];
  const metrics: Metrics = {
    capture: async (event, distinctId, properties) => void events.push({ event, distinctId, properties }),
  };
  const app = createApp({
    getDb: async () => db,
    tokenSecret: SECRET,
    metrics,
    sendEmail: async (e) => void emails.push(e),
  });
  const form = (path: string, fields: Record<string, string>, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(fields).toString(),
    });
  const codeFrom = (e: Email) => /code is ([0-9A-Z]{8})/.exec(e.text)![1]!;
  /** Runs the whole sign-in and returns the session cookie. */
  async function signIn(email: string) {
    await form("/login", { email });
    const res = await form("/login/verify", { email, code: codeFrom(emails.at(-1)!) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  return { app, events, emails, form, signIn };
}

const count = async (sql: string) => Number((await db.query<{ n: string }>(sql))[0]!.n);

describe("basics", () => {
  it("answers /health with 200", async () => {
    const res = await setup().app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves the landing page and records the view", async () => {
    const { app, events } = setup();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<h1>sesh</h1>");
    expect(events.map((e) => e.event)).toEqual(["landing_viewed"]);
  });
});

describe("sign-in", () => {
  it("sends signed-out requests for app pages to the login page", async () => {
    const { app, events } = setup();
    const res = await app.request("/app");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(events[0]).toMatchObject({ event: "app_redirected_to_login", properties: { reason: "signed_out" } });
  });

  it("treats a bad session cookie as signed out", async () => {
    const { app, events } = setup();
    const res = await app.request("/app", { headers: { cookie: "sesh_session=garbage" } });
    expect(res.headers.get("location")).toBe("/login");
    expect(events[0]).toMatchObject({ properties: { reason: "invalid_session" } });
  });

  it("creates a user with a personal org they own on first sign-in", async () => {
    const { app, signIn, events } = setup();
    const cookie = await signIn("First.Timer@example.com");
    const res = await app.request("/app", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("first.timer");
    expect(body).toContain("Org:");
    const rows = await db.query<{ role: string; personal: boolean }>(
      `SELECT m.role, o.personal_user_id = u.id AS personal FROM sesh.users u
       JOIN sesh.org_members m ON m.user_id = u.id JOIN sesh.orgs o ON o.id = m.org_id
       WHERE lower(u.email) = 'first.timer@example.com'`,
    );
    expect(rows).toEqual([{ role: "owner", personal: true }]);
    expect(events.map((e) => e.event)).toContain("signed_up");
    expect(events.map((e) => e.event)).toContain("shell_viewed");
  });

  it("signs a returning user in to the same org without creating duplicates", async () => {
    const { signIn, events } = setup();
    await signIn("repeat@example.com");
    await signIn("REPEAT@example.com");
    expect(await count(`SELECT count(*) AS n FROM sesh.users WHERE lower(email) = 'repeat@example.com'`)).toBe(1);
    expect(
      await count(
        `SELECT count(*) AS n FROM sesh.orgs o JOIN sesh.users u ON u.id = o.personal_user_id WHERE lower(u.email) = 'repeat@example.com'`,
      ),
    ).toBe(1);
    expect(events.filter((e) => e.event === "signed_up")).toHaveLength(1);
    expect(events.filter((e) => e.event === "logged_in")).toHaveLength(1);
  });

  it("rejects a bad email, a wrong code and a reused code, and records each", async () => {
    const { form, emails, events } = setup();
    expect((await form("/login", { email: "nope" })).status).toBe(400);
    expect(emails).toHaveLength(0);

    await form("/login", { email: "wrong@example.com" });
    expect((await form("/login/verify", { email: "wrong@example.com", code: "short" })).status).toBe(400);
    const real = /code is ([0-9A-Z]{8})/.exec(emails[0]!.text)![1]!;
    const wrong = real === "00000000" ? "11111111" : "00000000";
    expect((await form("/login/verify", { email: "wrong@example.com", code: wrong })).status).toBe(401);
    expect((await form("/login/verify", { email: "wrong@example.com", code: real })).status).toBe(302);
    expect((await form("/login/verify", { email: "wrong@example.com", code: real })).status).toBe(401);

    expect(events.filter((e) => e.event === "login_rejected").map((e) => e.properties)).toEqual([
      { reason: "invalid_email" },
    ]);
    expect(events.filter((e) => e.event === "verify_rejected").map((e) => e.properties!.reason)).toEqual([
      "malformed",
      "invalid_code",
      "invalid_code",
    ]);
  });

  it("sends only one code per address while one is live", async () => {
    const { form, emails, events } = setup();
    await form("/login", { email: "once@example.com" });
    await form("/login", { email: "once@example.com" });
    expect(emails).toHaveLength(1);
    expect(events.filter((e) => e.event === "login_requested").map((e) => e.properties!.sent)).toEqual([true, false]);
  });

  it("signs out", async () => {
    const { app, signIn, form } = setup();
    const cookie = await signIn("bye@example.com");
    const res = await form("/logout", {}, cookie);
    expect(res.headers.get("set-cookie")).toContain("sesh_session=;");
    expect((await app.request("/app")).status).toBe(302);
  });
});
