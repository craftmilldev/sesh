import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { openTestDb } from "../src/db/testing.js";
import { type Session, setupApp } from "./harness.js";

let db: Db;
beforeAll(async () => {
  db = await openTestDb();
});
afterAll(async () => {
  await db.close();
});

const setup = () => setupApp(db);
const count = async (sql: string) => Number((await db.query<{ n: string }>(sql))[0]!.n);
const orgIdByName = async (name: string) =>
  (await db.query<{ id: string }>(`SELECT id FROM sesh.orgs WHERE name = $1`, [name]))[0]!.id;
interface Me {
  user: { name: string };
  org: { id: string; name: string; role: string };
  orgs: { id: string; name: string; role: string }[];
}
const me = async (t: ReturnType<typeof setup>, session: Session) =>
  (await (await t.call("/me", { session })).json()) as Me;

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

  it("serves the same locked-down SPA shell for the login, app and invite pages", async () => {
    const { app, events } = setup();
    for (const path of ["/login", "/app", "/invite/abc_123"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('<div id="root"></div>');
      expect(body).toContain('<script type="module" src="/app.js"></script>');
      expect(res.headers.get("set-cookie")).toBeNull();
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).toContain("frame-ancestors 'none'");
    }
    expect(events.map((e) => e.event)).toEqual(["login_page_viewed"]);
  });

  it("answers an unknown API path with a JSON 404", async () => {
    const t = setup();
    const res = await t.call("/nope", { session: await t.signIn("lost@example.com") });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

describe("sign-in", () => {
  it("answers 401 to signed-out API calls and records why", async () => {
    const { call, events } = setup();
    const none = await call("/me");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    expect((await call("/me", { session: { token: "garbage" } })).status).toBe(401);
    expect(events.map((e) => [e.event, e.properties])).toEqual([
      ["api_unauthorized", { reason: "signed_out" }],
      ["api_unauthorized", { reason: "invalid_session" }],
    ]);
  });

  it("ignores cookies, so no auth state lives in them", async () => {
    const { app, call, signIn } = setup();
    const session = await signIn("nocookie@example.com");
    const res = await call("/login", { body: { email: "nocookie2@example.com" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    const verify = await app.request("/api/me", {
      headers: { cookie: `sesh_session=${session.token}`, "x-sesh-org": "x" },
    });
    expect(verify.status).toBe(401);
  });

  it("creates a user with a personal org they own on first sign-in", async () => {
    const t = setup();
    const session = await t.signIn("First.Timer@example.com");
    const body = await me(t, session);
    expect(body.user.name).toBe("first.timer");
    expect(body.org).toMatchObject({ name: "first.timer", role: "owner" });
    const rows = await db.query<{ role: string; personal: boolean }>(
      `SELECT m.role, o.personal_user_id = u.id AS personal FROM sesh.users u
       JOIN sesh.org_members m ON m.user_id = u.id JOIN sesh.orgs o ON o.id = m.org_id
       WHERE lower(u.email) = 'first.timer@example.com'`,
    );
    expect(rows).toEqual([{ role: "owner", personal: true }]);
    expect(t.events.map((e) => e.event)).toContain("signed_up");
    expect(t.events.map((e) => e.event)).toContain("shell_viewed");
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
    const { app, call, emails, events, codeFrom } = setup();
    const bad = await call("/login", { body: { email: "nope" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_email" });
    const notJson = await app.request("/api/login", { method: "POST", body: "{nope" });
    expect(notJson.status).toBe(400);
    expect(emails).toHaveLength(0);

    await call("/login", { body: { email: "wrong@example.com" } });
    const verify = (code: string) => call("/login/verify", { body: { email: "wrong@example.com", code } });
    expect((await verify("short")).status).toBe(400);
    const real = codeFrom(emails[0]!);
    const wrong = real === "00000000" ? "11111111" : "00000000";
    expect((await verify(wrong)).status).toBe(401);
    expect((await verify(real)).status).toBe(200);
    expect((await verify(real)).status).toBe(401);

    expect(events.filter((e) => e.event === "login_rejected").map((e) => e.properties)).toEqual([
      { reason: "invalid_email" },
      { reason: "invalid_email" },
    ]);
    expect(events.filter((e) => e.event === "verify_rejected").map((e) => e.properties!.reason)).toEqual([
      "malformed",
      "invalid_code",
      "invalid_code",
    ]);
  });

  it("sends only one code per address while one is live", async () => {
    const { call, emails, events } = setup();
    await call("/login", { body: { email: "once@example.com" } });
    await call("/login", { body: { email: "once@example.com" } });
    expect(emails).toHaveLength(1);
    expect(events.filter((e) => e.event === "login_requested").map((e) => e.properties!.sent)).toEqual([true, false]);
  });

  it("records signing out", async () => {
    const { call, signIn, events } = setup();
    const session = await signIn("bye@example.com");
    expect((await call("/logout", { body: {}, session })).status).toBe(200);
    expect(events.map((e) => e.event)).toContain("logged_out");
  });
});

describe("orgs", () => {
  /** Has the session's owner invite someone by email, and returns the invite token from the email that went out. */
  async function invite(t: ReturnType<typeof setup>, session: Session, to = "invitee@example.com") {
    const res = await t.call("/orgs/invite", { body: { email: to }, session });
    expect(res.status).toBe(201);
    const mail = t.emails.at(-1)!;
    expect(mail.to).toBe(to);
    return /\/invite\/([\w-]+)/.exec(mail.text)![1]!;
  }
  /** Makes an org and returns the session with it active. */
  async function makeOrg(t: ReturnType<typeof setup>, session: Session, name: string): Promise<Session> {
    const res = await t.call("/orgs", { body: { name }, session });
    expect(res.status).toBe(201);
    return { ...session, org: ((await res.json()) as { org: { id: string } }).org.id };
  }

  it("creates an org the user owns", async () => {
    const t = setup();
    const session = await t.signIn("founder@example.com");
    const empty = await t.call("/orgs", { body: { name: "" }, session });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "empty_name" });
    expect((await t.call("/orgs", { body: { name: "x".repeat(81) }, session })).status).toBe(400);
    const active = await makeOrg(t, session, "Founders Inc");
    expect((await me(t, active)).org).toMatchObject({ name: "Founders Inc", role: "owner" });
    expect(t.events.map((e) => e.event)).toContain("org_created");
    expect(t.events.filter((e) => e.event === "org_create_rejected").map((e) => e.properties)).toEqual([
      { reason: "empty_name" },
      { reason: "name_too_long" },
    ]);
  });

  it("lets an owner invite, the invitee join once after logging in, and rejects reuse", async () => {
    const t = setup();
    const owner = await makeOrg(t, await t.signIn("owner@example.com"), "Team A");
    const token = await invite(t, owner);

    // Signed out, the invite can't be looked up; the SPA sends the visitor to log in first.
    expect((await t.call(`/invites/${token}`)).status).toBe(401);

    const guest = await t.signIn("guest@example.com");
    const view = await t.call(`/invites/${token}`, { session: guest });
    expect(await view.json()).toEqual({ org: { id: await orgIdByName("Team A"), name: "Team A" } });
    const joined = await t.call(`/invites/${token}`, { body: {}, session: guest });
    expect(await joined.json()).toMatchObject({ org: { name: "Team A" }, already_member: false });
    const roles = await db.query(
      `SELECT m.role FROM sesh.org_members m JOIN sesh.users u ON u.id = m.user_id WHERE u.email = 'guest@example.com' AND m.org_id = $1`,
      [await orgIdByName("Team A")],
    );
    expect(roles).toEqual([{ role: "member" }]);
    expect(t.events.map((e) => e.event)).toContain("invite_accepted");

    // Used: rejected for anyone, on view and on accept.
    const other = await t.signIn("other@example.com");
    const used = await t.call(`/invites/${token}`, { session: other });
    expect(used.status).toBe(410);
    expect(await used.json()).toMatchObject({ error: "used" });
    expect((await t.call(`/invites/${token}`, { body: {}, session: other })).status).toBe(410);
    expect(t.events.filter((e) => e.event === "invite_rejected").map((e) => e.properties)).toEqual([
      { reason: "used", step: "view" },
      { reason: "used", step: "accept" },
    ]);
  });

  it("rejects an expired or unknown invite", async () => {
    const t = setup();
    const owner = await makeOrg(t, await t.signIn("expiry@example.com"), "Team Exp");
    const token = await invite(t, owner);
    const orgId = await orgIdByName("Team Exp");
    await db.query(`UPDATE sesh.org_invites SET expires_at = now() - interval '1 minute' WHERE org_id = $1`, [orgId]);
    const guest = await t.signIn("late@example.com");
    expect((await t.call(`/invites/${token}`, { body: {}, session: guest })).status).toBe(410);
    expect((await t.call("/invites/nope", { session: guest })).status).toBe(410);
    expect(await count(`SELECT count(*) AS n FROM sesh.org_members WHERE org_id = '${orgId}'`)).toBe(1);
  });

  it("does not let members invite", async () => {
    const t = setup();
    const owner = await makeOrg(t, await t.signIn("boss@example.com"), "Team M");
    const token = await invite(t, owner);
    const member = await t.signIn("worker@example.com");
    await t.call(`/invites/${token}`, { body: {}, session: member });
    const res = await t.call("/orgs/invite", {
      body: { email: "x@example.com" },
      session: { ...member, org: await orgIdByName("Team M") },
    });
    expect(res.status).toBe(403);
    expect(t.events.find((e) => e.event === "invite_create_rejected")!.properties).toEqual({ reason: "not_owner" });
    expect(
      await count(
        `SELECT count(*) AS n FROM sesh.org_invites WHERE created_by = (SELECT id FROM sesh.users WHERE email = 'worker@example.com')`,
      ),
    ).toBe(0);
  });

  it("rejects an invite to a bad email address", async () => {
    const { call, signIn, emails, events } = setup();
    const owner = await signIn("picky@example.com");
    const before = emails.length;
    expect((await call("/orgs/invite", { body: { email: "nope" }, session: owner })).status).toBe(400);
    expect(emails).toHaveLength(before);
    expect(events.find((e) => e.event === "invite_create_rejected")!.properties).toEqual({ reason: "invalid_email" });
  });

  it("caps how many invites an owner can send in a day", async () => {
    const t = setup();
    const owner = await makeOrg(t, await t.signIn("spammer@example.com"), "Team Cap");
    await db.query(
      `INSERT INTO sesh.org_invites (id, org_id, token_hash, created_by, expires_at)
       SELECT gen_random_uuid(), o.id, 'cap-' || g, u.id, now() + interval '1 day'
       FROM generate_series(1, 20) g, sesh.orgs o, sesh.users u WHERE o.name = 'Team Cap' AND u.email = 'spammer@example.com'`,
    );
    const before = t.emails.length;
    expect((await t.call("/orgs/invite", { body: { email: "victim@example.com" }, session: owner })).status).toBe(429);
    expect(t.emails).toHaveLength(before);
    expect(t.events.find((e) => e.event === "invite_create_rejected")!.properties).toEqual({ reason: "rate_limited" });
  });

  it("switches between orgs and refuses an org the user is not in", async () => {
    const t = setup();
    const personal = await t.signIn("multi@example.com");
    await makeOrg(t, personal, "Second Org");
    const switched = await t.call("/orgs/switch", { body: { org: await orgIdByName("multi") }, session: personal });
    expect(switched.status).toBe(200);
    const body = await me(t, { ...personal, org: await orgIdByName("multi") });
    expect(body.org).toMatchObject({ name: "multi", role: "owner" });
    expect(body.orgs.map((o) => o.name).sort()).toEqual(["Second Org", "multi"]);

    // Someone else's org can't be switched to, and a forged org header falls back to one they belong to.
    const second = await orgIdByName("Second Org");
    const stranger = await t.signIn("stranger@example.com");
    expect((await t.call("/orgs/switch", { body: { org: second }, session: stranger })).status).toBe(403);
    const forged = await me(t, { ...stranger, org: second });
    expect(forged.org.name).toBe("stranger");
    expect(forged.orgs.map((o) => o.name)).toEqual(["stranger"]);
    expect(t.events.find((e) => e.event === "org_switch_rejected")!.properties).toEqual({ reason: "not_a_member" });
  });

  it("scopes tokens to the active org and leaves the invite when a member opens it again", async () => {
    const t = setup();
    const owner = await makeOrg(t, await t.signIn("keeper@example.com"), "Team K");
    const token = await invite(t, owner);
    const again = await t.call(`/invites/${token}`, { body: {}, session: owner });
    expect(await again.json()).toMatchObject({ already_member: true });
    expect(
      await count(
        `SELECT count(*) AS n FROM sesh.org_invites WHERE used_at IS NOT NULL AND org_id = '${await orgIdByName("Team K")}'`,
      ),
    ).toBe(0);
    const guest = await t.signIn("later@example.com");
    expect((await t.call(`/invites/${token}`, { body: {}, session: guest })).status).toBe(200);
  });
});
