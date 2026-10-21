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
    if ("problem" in result) {
      await metrics.capture("verify_rejected", ANONYMOUS, { reason: result.problem });
      return c.html(codeForm(email, "That code is invalid or has expired."), 401);
    }
    await metrics.capture(result.created ? "signed_up" : "logged_in", result.user.id);
    const { token } = signSessionToken(result.user.id, opts.tokenSecret);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.redirect("/app");
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

  // App pages: signed-out requests go to the login page.
  const appPages = new Hono<{ Variables: { user: store.User } }>();
  appPages.use(async (c, next) => {
    const user = await currentUser(c);
    if (!user) {
      await metrics.capture("app_redirected_to_login", ANONYMOUS, {
        reason: getCookie(c, SESSION_COOKIE) ? "invalid_session" : "signed_out",
      });
      return c.redirect("/login");
    }
    c.set("user", user);
    await next();
  });

  appPages.get("/", async (c) => {
    const user = c.var.user;
    const org = await store.personalOrg(await opts.getDb(), user.id);
    await metrics.capture("shell_viewed", user.id);
    return c.html(
      page(
        "sesh",
        html`<h1>sesh</h1>
          <p>Signed in as <strong>${user.name}</strong>.</p>
          <p>Org: <strong>${org?.name ?? ""}</strong></p>
          <form method="post" action="/logout"><button type="submit">Sign out</button></form>`,
      ),
    );
  });
  app.route("/app", appPages);

  return app;
}
