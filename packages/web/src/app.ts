import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Db } from "./db/index.js";
import { consoleSender, type SendEmail } from "./email.js";
import { LOGIN_CODE_RE, normalizeLoginCode } from "./ids.js";
import { ANONYMOUS, type Metrics, noopMetrics } from "./metrics.js";
import * as store from "./store.js";
import { SESSION_TTL_SECONDS, signSessionToken, verifyToken } from "./tokens.js";

export interface AppOptions {
  getDb: () => Promise<Db>;
  /** Signs session tokens (JWTs). */
  tokenSecret: string;
  metrics?: Metrics;
  /** Delivers login codes. Defaults to printing them to the console. */
  sendEmail?: SendEmail;
}

const SESSION_COOKIE = "sesh_session";
/** The org the user last switched to. Only a hint: it is checked against their memberships on every request. */
const ORG_COOKIE = "sesh_org";
/** Where to go after sign-in when an invite link sent a signed-out visitor to log in. */
const NEXT_COOKIE = "sesh_next";
const INVITE_PATH_RE = /^\/invite\/[A-Za-z0-9_-]{1,100}$/;
const MAX_ORG_NAME = 80;
const cookieOpts = (c: Context, maxAge: number) => ({
  httpOnly: true,
  sameSite: "Lax" as const,
  secure: new URL(c.req.url).protocol === "https:",
  path: "/",
  maxAge,
});
/** A form field's text; empty when it is missing or a file. */
const field = (body: Record<string, unknown>, name: string) =>
  typeof body[name] === "string" ? body[name].trim() : "";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const page = (title: string, body: ReturnType<typeof html>) =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          body {
            font:
              18px/1.5 system-ui,
              sans-serif;
            max-width: 36rem;
            margin: 6rem auto;
            padding: 0 1rem;
          }
          input,
          button {
            font: inherit;
          }
          .error {
            color: #b00020;
          }
        </style>
      </head>
      <body>
        ${body}
      </body>
    </html>`;

const emailForm = (error?: string) =>
  page(
    "Sign in · sesh",
    html`<h1>Sign in to sesh</h1>
      ${error ? html`<p class="error">${error}</p>` : ""}
      <form method="post" action="/login">
        <p>
          <label>Email <input type="email" name="email" required autofocus /></label>
        </p>
        <p><button type="submit">Send me a code</button></p>
      </form>`,
  );

const codeForm = (email: string, error?: string) =>
  page(
    "Enter your code · sesh",
    html`<h1>Check your email</h1>
      <p>We sent a login code to ${email}. It expires in ${store.LOGIN_CODE_TTL_MINUTES} minutes.</p>
      ${error ? html`<p class="error">${error}</p>` : ""}
      <form method="post" action="/login/verify">
        <input type="hidden" name="email" value="${email}" />
        <p>
          <label>Code <input name="code" required autofocus autocomplete="one-time-code" /></label>
        </p>
        <p><button type="submit">Sign in</button></p>
      </form>`,
  );

const inviteProblem = () =>
  page(
    "Invite · sesh",
    html`<h1>This invite doesn't work</h1>
      <p>It was already used, has expired, or never existed. Ask an owner for a new one.</p>
      <p><a href="/app">Back to sesh</a></p>`,
  );

export function createApp(opts: AppOptions) {
  const metrics = opts.metrics ?? noopMetrics;
  const sendEmail = opts.sendEmail ?? consoleSender;
  const app = new Hono();

  // Nothing is checked yet (there is no database); a failing check will return 503 and record health_check_failed.
  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/", async (c) => {
    await metrics.capture("landing_viewed", ANONYMOUS);
    return c.html(
      page(
        "sesh",
        html`<h1>sesh</h1>
          <p>Session insights for Claude Code teams. It shows the shape of the work, never who did it.</p>
          <p><a href="/login">Sign in</a></p>`,
      ),
    );
  });

  app.get("/login", async (c) => {
    await metrics.capture("login_page_viewed", ANONYMOUS);
    return c.html(emailForm());
  });

  // Email a one-time code. Answers the same whether or not a code was already sent (one per address per TTL).
  app.post("/login", async (c) => {
    const email = field(await c.req.parseBody(), "email");
    if (!EMAIL_RE.test(email) || email.length > 320) {
      await metrics.capture("login_rejected", ANONYMOUS, { reason: "invalid_email" });
      return c.html(emailForm("That doesn't look like an email address."), 400);
    }
    const login = await store.createLoginCode(await opts.getDb(), email);
    await metrics.capture("login_requested", ANONYMOUS, { sent: !!login.code });
    if (login.code) {
      try {
        await sendEmail({
          to: login.email,
          subject: `Your sesh login code: ${login.code}`,
          text: `Your sesh login code is ${login.code}\n\nIt expires in ${store.LOGIN_CODE_TTL_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
        });
      } catch (err) {
        await metrics.capture("login_email_failed", ANONYMOUS);
        throw err;
      }
    }
    return c.html(codeForm(login.email), 202);
  });

  // Trade the code for a session cookie, creating the user and their personal org if the email is new.
  app.post("/login/verify", async (c) => {
    const body = await c.req.parseBody();
    const email = field(body, "email");
    const code = normalizeLoginCode(field(body, "code"));
    if (!EMAIL_RE.test(email) || !LOGIN_CODE_RE.test(code)) {
      await metrics.capture("verify_rejected", ANONYMOUS, { reason: "malformed" });
      return c.html(codeForm(email, "That code doesn't look right."), 400);
    }
    const result = await store.redeemLoginCode(await opts.getDb(), email, code);
    if (!result.ok) {
      await metrics.capture("verify_rejected", ANONYMOUS, { reason: result.problem });
      return c.html(codeForm(email, "That code is invalid or has expired."), 401);
    }
    await metrics.capture(result.created ? "signed_up" : "logged_in", result.user.id);
    const { token } = signSessionToken(result.user.id, opts.tokenSecret);
    setCookie(c, SESSION_COOKIE, token, cookieOpts(c, SESSION_TTL_SECONDS));
    const next = getCookie(c, NEXT_COOKIE);
    deleteCookie(c, NEXT_COOKIE, { path: "/" });
    return c.redirect(next && INVITE_PATH_RE.test(next) ? next : "/app");
  });

  app.post("/logout", async (c) => {
    const user = await currentUser(c);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    if (user) await metrics.capture("logged_out", user.id);
    return c.redirect("/");
  });

  async function currentUser(c: Context) {
    const token = getCookie(c, SESSION_COOKIE);
    const claims = token ? verifyToken(token, opts.tokenSecret) : undefined;
    return claims ? store.findUserById(await opts.getDb(), claims.sub) : undefined;
  }

  // An invite link. Signed out, it sends the visitor to log in and then back here; signed in, it asks to join.
  app.get("/invite/:token", async (c) => {
    const user = await currentUser(c);
    const token = c.req.param("token");
    if (!user) {
      setCookie(c, NEXT_COOKIE, `/invite/${token}`, cookieOpts(c, 60 * 60));
      await metrics.capture("invite_redirected_to_login", ANONYMOUS);
      return c.redirect("/login");
    }
    const invite = await store.findInvite(await opts.getDb(), token);
    if (!invite.ok) {
      await metrics.capture("invite_rejected", user.id, { reason: invite.problem, step: "view" });
      return c.html(inviteProblem(), 410);
    }
    await metrics.capture("invite_viewed", user.id);
    return c.html(
      page(
        "Join an org · sesh",
        html`<h1>Join ${invite.org.name}</h1>
          <form method="post" action="/invite/${token}"><button type="submit">Join this org</button></form>`,
      ),
    );
  });

  app.post("/invite/:token", async (c) => {
    const user = await currentUser(c);
    if (!user) return c.redirect("/login");
    const result = await store.acceptInvite(await opts.getDb(), user.id, c.req.param("token"));
    if (!result.ok) {
      await metrics.capture("invite_rejected", user.id, { reason: result.problem, step: "accept" });
      return c.html(inviteProblem(), 410);
    }
    await metrics.capture("invite_accepted", user.id, { already_member: result.alreadyMember });
    setCookie(c, ORG_COOKIE, result.org.id, cookieOpts(c, SESSION_TTL_SECONDS));
    return c.redirect("/app");
  });

  // App pages: signed-out requests go to the login page. Every page is scoped to the active org.
  const appPages = new Hono<{ Variables: { user: store.User; org: store.Membership; orgs: store.Membership[] } }>();
  appPages.use(async (c, next) => {
    const user = await currentUser(c);
    if (!user) {
      await metrics.capture("app_redirected_to_login", ANONYMOUS, {
        reason: getCookie(c, SESSION_COOKIE) ? "invalid_session" : "signed_out",
      });
      return c.redirect("/login");
    }
    const orgs = await store.userOrgs(await opts.getDb(), user.id);
    const wanted = getCookie(c, ORG_COOKIE);
    const org = orgs.find((o) => o.id === wanted) ?? orgs[0];
    if (!org) throw new Error(`user ${user.id} belongs to no org`);
    c.set("user", user);
    c.set("orgs", orgs);
    c.set("org", org);
    await next();
  });

  const shell = (
    c: Context<{ Variables: { user: store.User; org: store.Membership; orgs: store.Membership[] } }>,
    extra = html``,
    error?: string,
  ) => {
    const { user, org, orgs } = c.var;
    return page(
      "sesh",
      html`<h1>sesh</h1>
        <p>Signed in as <strong>${user.name}</strong>.</p>
        <p>Org: <strong>${org.name}</strong> (${org.role})</p>
        ${error ? html`<p class="error">${error}</p>` : ""} ${extra}
        ${
          orgs.length > 1
            ? html`<form method="post" action="/app/orgs/switch">
                <label
                  >Switch org
                  <select name="org">
                    ${orgs.map((o) => html`<option value="${o.id}" ${o.id === org.id ? "selected" : ""}>${o.name}</option>`)}
                  </select></label
                >
                <button type="submit">Switch</button>
              </form>`
            : ""
        }
        <form method="post" action="/app/orgs">
          <label>New org <input name="name" required maxlength="${MAX_ORG_NAME}" /></label>
          <button type="submit">Create</button>
        </form>
        ${
          org.role === "owner"
            ? html`<form method="post" action="/app/orgs/invite">
                <label>Invite by email <input type="email" name="email" required /></label>
                <button type="submit">Send invite to ${org.name}</button>
              </form>`
            : ""
        }
        <form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
    );
  };

  appPages.get("/", async (c) => {
    await metrics.capture("shell_viewed", c.var.user.id);
    return c.html(shell(c));
  });

  appPages.post("/orgs", async (c) => {
    const user = c.var.user;
    const name = field(await c.req.parseBody(), "name");
    if (!name || name.length > MAX_ORG_NAME) {
      await metrics.capture("org_create_rejected", user.id, { reason: name ? "name_too_long" : "empty_name" });
      return c.html(shell(c, html``, `Give the org a name of up to ${MAX_ORG_NAME} characters.`), 400);
    }
    const org = await store.createOrg(await opts.getDb(), user.id, name);
    await metrics.capture("org_created", user.id);
    setCookie(c, ORG_COOKIE, org.id, cookieOpts(c, SESSION_TTL_SECONDS));
    return c.redirect("/app");
  });

  appPages.post("/orgs/switch", async (c) => {
    const user = c.var.user;
    const wanted = field(await c.req.parseBody(), "org");
    const target = c.var.orgs.find((o) => o.id === wanted);
    if (!target) {
      await metrics.capture("org_switch_rejected", user.id, { reason: "not_a_member" });
      return c.html(shell(c, html``, "You aren't a member of that org."), 403);
    }
    await metrics.capture("org_switched", user.id);
    setCookie(c, ORG_COOKIE, target.id, cookieOpts(c, SESSION_TTL_SECONDS));
    return c.redirect("/app");
  });

  // Invites are always for the active org, so there is no org id to tamper with.
  appPages.post("/orgs/invite", async (c) => {
    const { user, org } = c.var;
    const email = field(await c.req.parseBody(), "email").toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 320) {
      await metrics.capture("invite_create_rejected", user.id, { reason: "invalid_email" });
      return c.html(shell(c, html``, "That doesn't look like an email address."), 400);
    }
    const token = await store.createInvite(await opts.getDb(), user.id, org.id);
    if (!token) {
      await metrics.capture("invite_create_rejected", user.id, { reason: "not_owner" });
      return c.html(shell(c, html``, "Only owners can invite people."), 403);
    }
    await metrics.capture("invite_created", user.id);
    try {
      await sendEmail({
        to: email,
        subject: `Join ${org.name} on sesh`,
        text: `${user.name} invited you to ${org.name} on sesh.\n\nSign in and join: ${new URL(c.req.url).origin}/invite/${token}\n\nThe link works once and expires in ${store.INVITE_TTL_DAYS} days.`,
      });
    } catch (err) {
      await metrics.capture("invite_email_failed", user.id);
      throw err;
    }
    return c.html(
      shell(c, html`<p>Invite sent to ${email}. The link works once and expires in ${store.INVITE_TTL_DAYS} days.</p>`),
    );
  });
  app.route("/app", appPages);

  return app;
}
