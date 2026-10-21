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
  return { app, events, emails, form, signIn, codeFrom };
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

describe("orgs", () => {
  const codeFrom = (e: Email) => /code is ([0-9A-Z]{8})/.exec(e.text)![1]!;
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
  const orgIdByName = async (name: string) =>
    (await db.query<{ id: string }>(`SELECT id FROM sesh.orgs WHERE name = $1`, [name]))[0]!.id;
  /** The invite path (/invite/<token>) out of the page that shows the new link. */
  const invitePath = async (res: Response) => /\/invite\/[\w-]+/.exec(await res.text())![0];

  it("creates an org the user owns and makes it active", async () => {
    const { app, form, signIn, events } = setup();
    const cookie = await signIn("founder@example.com");
    expect((await form("/app/orgs", { name: "" }, cookie)).status).toBe(400);
    const res = await form("/app/orgs", { name: "Founders Inc" }, cookie);
    expect(res.status).toBe(302);
    const body = await (await app.request("/app", { headers: { cookie: `${cookie}; ${cookieOf(res)}` } })).text();
    expect(body).toContain("Founders Inc");
    expect(body).toContain("(owner)");
    expect(events.map((e) => e.event)).toContain("org_created");
    expect(events.find((e) => e.event === "org_create_rejected")!.properties).toEqual({ reason: "empty_name" });
  });

  it("lets an owner invite, the invitee join once after logging in, and rejects reuse", async () => {
    const { app, form, signIn, emails, events } = setup();
    const owner = await signIn("owner@example.com");
    const made = await form("/app/orgs", { name: "Team A" }, owner);
    const link = await invitePath(await form("/app/orgs/invite", {}, `${owner}; ${cookieOf(made)}`));

    // Signed out: sent to log in, and back to the invite afterwards.
    const out = await app.request(link);
    expect(out.headers.get("location")).toBe("/login");
    await form("/login", { email: "guest@example.com" });
    const verified = await form(
      "/login/verify",
      { email: "guest@example.com", code: codeFrom(emails.at(-1)!) },
      cookieOf(out),
    );
    expect(verified.headers.get("location")).toBe(link);
    const guest = cookieOf(verified)
      .split("; ")
      .find((c) => c.startsWith("sesh_session="))!;

    expect(await (await app.request(link, { headers: { cookie: guest } })).text()).toContain("Join Team A");
    const joined = await form(link, {}, guest);
    expect(joined.headers.get("location")).toBe("/app");
    const roles = await db.query(
      `SELECT m.role FROM sesh.org_members m JOIN sesh.users u ON u.id = m.user_id WHERE u.email = 'guest@example.com' AND m.org_id = $1`,
      [await orgIdByName("Team A")],
    );
    expect(roles).toEqual([{ role: "member" }]);
    expect(events.map((e) => e.event)).toContain("invite_accepted");

    // Used: rejected for anyone, on view and on accept.
    const other = await signIn("other@example.com");
    expect((await app.request(link, { headers: { cookie: other } })).status).toBe(410);
    expect((await form(link, {}, other)).status).toBe(410);
    expect(events.filter((e) => e.event === "invite_rejected").map((e) => e.properties)).toEqual([
      { reason: "used", step: "view" },
      { reason: "used", step: "accept" },
    ]);
  });

  it("rejects an expired or unknown invite", async () => {
    const { form, app, signIn } = setup();
    const owner = await signIn("expiry@example.com");
    const made = await form("/app/orgs", { name: "Team Exp" }, owner);
    const link = await invitePath(await form("/app/orgs/invite", {}, `${owner}; ${cookieOf(made)}`));
    const orgId = await orgIdByName("Team Exp");
    await db.query(`UPDATE sesh.org_invites SET expires_at = now() - interval '1 minute' WHERE org_id = $1`, [orgId]);
    const guest = await signIn("late@example.com");
    expect((await form(link, {}, guest)).status).toBe(410);
    expect((await app.request("/invite/nope", { headers: { cookie: guest } })).status).toBe(410);
    expect(await count(`SELECT count(*) AS n FROM sesh.org_members WHERE org_id = '${orgId}'`)).toBe(1);
  });

  it("does not let members invite", async () => {
    const { form, signIn, events } = setup();
    const owner = await signIn("boss@example.com");
    const made = await form("/app/orgs", { name: "Team M" }, owner);
    const link = await invitePath(await form("/app/orgs/invite", {}, `${owner}; ${cookieOf(made)}`));
    const member = await signIn("worker@example.com");
    const joined = await form(link, {}, member);
    const res = await form("/app/orgs/invite", {}, `${member}; ${cookieOf(joined)}`);
    expect(res.status).toBe(403);
    expect(events.find((e) => e.event === "invite_create_rejected")!.properties).toEqual({ reason: "not_owner" });
    expect(
      await count(
        `SELECT count(*) AS n FROM sesh.org_invites WHERE created_by = (SELECT id FROM sesh.users WHERE email = 'worker@example.com')`,
      ),
    ).toBe(0);
  });

  it("switches between orgs and refuses an org the user is not in", async () => {
    const { app, form, signIn, events } = setup();
    const a = await signIn("multi@example.com");
    await form("/app/orgs", { name: "Second Org" }, a);
    const res = await form("/app/orgs/switch", { org: await orgIdByName("multi") }, a);
    expect(res.status).toBe(302);
    const body = await (await app.request("/app", { headers: { cookie: `${a}; ${cookieOf(res)}` } })).text();
    expect(body).toContain("<strong>multi</strong> (owner)");
    expect(body).toContain("Second Org");

    // Someone else's org can't be switched to, and a forged org cookie falls back to one they belong to.
    const second = await orgIdByName("Second Org");
    const stranger = await signIn("stranger@example.com");
    expect((await form("/app/orgs/switch", { org: second }, stranger)).status).toBe(403);
    const forged = await (await app.request("/app", { headers: { cookie: `${stranger}; sesh_org=${second}` } })).text();
    expect(forged).not.toContain("Second Org");
    expect(forged).toContain("<strong>stranger</strong>");
    expect(events.find((e) => e.event === "org_switch_rejected")!.properties).toEqual({ reason: "not_a_member" });
  });

  it("keeps the invite when an existing member opens it, and ignores a non-invite next path", async () => {
    const { form, signIn, emails } = setup();
    const owner = await signIn("keeper@example.com");
    const made = await form("/app/orgs", { name: "Team K" }, owner);
    const active = `${owner}; ${cookieOf(made)}`;
    const link = await invitePath(await form("/app/orgs/invite", {}, active));
    expect((await form(link, {}, active)).status).toBe(302);
    expect(
      await count(
        `SELECT count(*) AS n FROM sesh.org_invites WHERE used_at IS NOT NULL AND org_id = '${await orgIdByName("Team K")}'`,
      ),
    ).toBe(0);
    const guest = await signIn("later@example.com");
    expect((await form(link, {}, guest)).status).toBe(302);

    await form("/login", { email: "nexty@example.com" });
    const res = await form(
      "/login/verify",
      { email: "nexty@example.com", code: codeFrom(emails.at(-1)!) },
      "sesh_next=https://evil.example/",
    );
    expect(res.headers.get("location")).toBe("/app");
    void app;
  });
});
