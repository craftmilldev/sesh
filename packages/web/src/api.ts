import { Hono, type Context } from "hono";
import type { Db } from "./db/index.js";
import { consoleSender, type SendEmail } from "./email.js";
import { LOGIN_CODE_RE, normalizeLoginCode } from "./ids.js";
import { ANONYMOUS, type Metrics, noopMetrics } from "./metrics.js";
import { parseUtcDay, utcDay } from "./day.js";
import { decodeJsonPayload, parsePlanUsage } from "./claude-code.js";
import { parsePending } from "./parse.js";
import * as store from "./store.js";
import { signSessionToken, verifyToken } from "./tokens.js";
import { createWeb } from "./ui.js";

export interface AppOptions {
  getDb: () => Promise<Db>;
  /** Signs session tokens (JWTs). */
  tokenSecret: string;
  metrics?: Metrics;
  /** Delivers login codes. Defaults to printing them to the console. */
  sendEmail?: SendEmail;
  /** The current time; tests set it. Defaults to the clock. */
  now?: () => Date;
}

/** The header the SPA names its active org in. Only a hint: it is checked against the user's memberships on every request. */
export const ORG_HEADER = "x-sesh-org";
const MAX_ORG_NAME = 80;
const MAX_TOKEN_NAME = 80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The largest OTLP request accepted, just under Vercel's own 4.5 MB request limit. */
const MAX_INGEST_BYTES = 4 * 1024 * 1024;
/** Status line posts are tiny; anything bigger is not one. */
const MAX_LIMITS_BYTES = 4096;
/** How far ahead of the server clock a snapshot's captured_at may be. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A JSON body's text field; empty when it is missing or not a string. */
const field = (body: Record<string, unknown>, name: string) =>
  typeof body[name] === "string" ? body[name].trim() : "";

/** The JSON object a request sent; empty when the body isn't one. */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** A 0 to 100 percentage; null when absent, "invalid" when present but not one. */
const percent = (v: unknown) =>
  v == null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : ("invalid" as const);

/** A unix-seconds time as a Date; null when absent, "invalid" when present but not one. */
const unixTime = (v: unknown) =>
  v == null
    ? null
    : typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e11
      ? new Date(v * 1000)
      : ("invalid" as const);

const publicEvent = (e: store.EventRow) => ({ ...e, occurred_at: e.occurred_at.toISOString() });

const publicOrg = (o: store.Org) => ({ id: o.id, name: o.name });

/** Reads a request body, giving up (undefined) as soon as it passes `max` bytes, so chunked uploads can't be buffered whole. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (stream) {
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      size += r.value.length;
      if (size > max) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(r.value);
    }
  }
  return new Uint8Array(Buffer.concat(chunks));
}

type ApiEnv = { Variables: { user: store.User } };
type OrgEnv = { Variables: { user: store.User; org: store.Membership; orgs: store.Membership[] } };

export function createApp(opts: AppOptions) {
  const metrics = opts.metrics ?? noopMetrics;
  const sendEmail = opts.sendEmail ?? consoleSender;
  const now = opts.now ?? (() => new Date());
  const app = new Hono();

  // Nothing is checked yet (there is no database); a failing check will return 503 and record health_check_failed.
  app.get("/health", (c) => c.json({ ok: true }));

  // The signed-in app is a SPA: these paths, and its bundle, are served by ui.ts and everything else is the JSON API.
  app.route("/", createWeb({ metrics }));

  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 410 | 429, error: string, message: string) =>
    c.json({ error, message }, status);

  const api = new Hono<ApiEnv>();
  api.onError((err, c) => {
    console.error(err);
    return c.json({ error: "server_error", message: "Something went wrong." }, 500);
  });

  // Email a one-time code. Answers the same whether or not a code was already sent (one per address per TTL).
  api.post("/login", async (c) => {
    const email = field(await jsonBody(c), "email");
    if (!EMAIL_RE.test(email) || email.length > 320) {
      await metrics.capture("login_rejected", ANONYMOUS, { reason: "invalid_email" });
      return fail(c, 400, "invalid_email", "That doesn't look like an email address.");
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
    return c.json({ email: login.email, ttl_minutes: store.LOGIN_CODE_TTL_MINUTES }, 202);
  });

  // Trade the code for a session token, creating the user and their personal org if the email is new. The client keeps
  // the token and sends it in the Authorization header; the server sets no cookie.
  api.post("/login/verify", async (c) => {
    const body = await jsonBody(c);
    const email = field(body, "email");
    const code = normalizeLoginCode(field(body, "code"));
    if (!EMAIL_RE.test(email) || !LOGIN_CODE_RE.test(code)) {
      await metrics.capture("verify_rejected", ANONYMOUS, { reason: "malformed" });
      return fail(c, 400, "malformed", "That code doesn't look right.");
    }
    const result = await store.redeemLoginCode(await opts.getDb(), email, code);
    if ("problem" in result) {
      await metrics.capture("verify_rejected", ANONYMOUS, { reason: result.problem });
      return fail(c, 401, result.problem, "That code is invalid or has expired.");
    }
    await metrics.capture(result.created ? "signed_up" : "logged_in", result.user.id);
    const { token } = signSessionToken(result.user.id, opts.tokenSecret);
    return c.json({ token, user: { name: result.user.name } });
  });

  // Every route below needs a valid session token in the Authorization header.
  api.use(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const claims = bearer ? verifyToken(bearer, opts.tokenSecret) : undefined;
    const user = claims ? await store.findUserById(await opts.getDb(), claims.sub) : undefined;
    if (!user) {
      await metrics.capture("api_unauthorized", ANONYMOUS, { reason: bearer ? "invalid_session" : "signed_out" });
      return c.json({ error: "unauthorized", message: "Sign in to continue." }, 401, { "WWW-Authenticate": "Bearer" });
    }
    c.set("user", user);
    await next();
  });

  // The token is a stateless JWT, so signing out is the client dropping it; this only records that it did.
  api.post("/logout", async (c) => {
    await metrics.capture("logged_out", c.var.user.id);
    return c.json({ ok: true });
  });

  // An invite link's org. The invite is spent only by accepting it.
  api.get("/invites/:token", async (c) => {
    const user = c.var.user;
    const invite = await store.findInvite(await opts.getDb(), c.req.param("token"));
    if ("problem" in invite) {
      await metrics.capture("invite_rejected", user.id, { reason: invite.problem, step: "view" });
      return fail(c, 410, invite.problem, "This invite was already used, has expired, or never existed.");
    }
    await metrics.capture("invite_viewed", user.id);
    return c.json({ org: publicOrg(invite.org) });
  });

  api.post("/invites/:token", async (c) => {
    const user = c.var.user;
    const result = await store.acceptInvite(await opts.getDb(), user.id, c.req.param("token"));
    if ("problem" in result) {
      await metrics.capture("invite_rejected", user.id, { reason: result.problem, step: "accept" });
      return fail(c, 410, result.problem, "This invite was already used, has expired, or never existed.");
    }
    await metrics.capture("invite_accepted", user.id, { already_member: result.alreadyMember });
    return c.json({ org: publicOrg(result.org), already_member: result.alreadyMember });
  });

  // Org-scoped routes: the active org is the one named in the X-Sesh-Org header if the user belongs to it, otherwise
  // the first they belong to.
  const scoped = new Hono<OrgEnv>();
  scoped.use(async (c, next) => {
    const user = c.var.user;
    const orgs = await store.userOrgs(await opts.getDb(), user.id);
    const wanted = c.req.header(ORG_HEADER);
    const org = orgs.find((o) => o.id === wanted) ?? orgs[0];
    if (!org) throw new Error(`user ${user.id} belongs to no org`);
    c.set("orgs", orgs);
    c.set("org", org);
    await next();
  });

  const membership = (m: store.Membership) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    counts_toward_team: m.counts_toward_team,
  });

  scoped.get("/me", async (c) => {
    const { user, org, orgs } = c.var;
    await metrics.capture("shell_viewed", user.id);
    return c.json({
      user: { name: user.name },
      org: membership(org),
      orgs: orgs.map(membership),
      ingest_endpoint: new URL(c.req.url).origin,
    });
  });

  // The org's sessions, newest first. Pages are numbered from 1.
  scoped.get("/sessions", async (c) => {
    const { user, org } = c.var;
    const raw = c.req.query("page") ?? "1";
    const page = Number(raw);
    if (!/^\d{1,6}$/.test(raw) || page < 1) {
      await metrics.capture("sessions_rejected", user.id, { reason: "invalid_page" });
      return fail(c, 400, "invalid_page", "Pages are numbered from 1.");
    }
    const { sessions, total } = await store.listSessions(await opts.getDb(), org.id, page);
    await metrics.capture("sessions_viewed", user.id, {
      empty: total === 0,
      page_beyond_end: !!total && !sessions.length,
    });
    return c.json({
      page,
      page_size: store.SESSIONS_PAGE_SIZE,
      total,
      sessions: sessions.map((s) => ({ ...s, started_at: s.started_at.toISOString() })),
    });
  });

  // The team's plan windows as one pool (see store.poolUsed). Names no one.
  scoped.get("/limits", async (c) => {
    const { user, org } = c.var;
    const pool = await store.planPool(await opts.getDb(), org.id, now());
    await metrics.capture("limits_viewed", user.id, { empty: !pool.five_hour_reporting && !pool.seven_day_reporting });
    return c.json(pool);
  });

  // What the org did today (the UTC day), by when each prompt and event happened: totals and the 5 heaviest
  // sessions. `day=YYYY-MM-DD` asks for another UTC day, for a session's share of the day it started.
  scoped.get("/today", async (c) => {
    const { user, org } = c.var;
    const dayParam = c.req.query("day");
    const day = dayParam === undefined ? utcDay(now()) : parseUtcDay(dayParam);
    if (!day) {
      await metrics.capture("today_rejected", user.id, { reason: "invalid_day" });
      return fail(c, 400, "invalid_day", "day must be a date like 2026-10-22.");
    }
    const { totals, top, orgSessions } = await store.activityBetween(await opts.getDb(), org.id, day.start, day.end, 5);
    await metrics.capture("today_viewed", user.id, {
      empty: totals.sessions === 0,
      org_empty: orgSessions === 0,
      other_day: dayParam !== undefined,
    });
    return c.json({
      ...totals,
      org_sessions: orgSessions,
      top: top.map((s) => ({
        id: s.id,
        started_at: s.started_at.toISOString(),
        tokens: s.tokens,
        cache_read_tokens: s.cache_read_tokens,
        prompts: s.prompts,
        tool_calls: s.tool_calls,
      })),
    });
  });

  // Tool calls, prompts and active sessions for each of the last 7, 14 or 28 UTC days (zero-filled, oldest first),
  // with today's three numbers, and tool calls per prompt (null on a day with no prompts, to two decimals).
  // `by_dow` is the average per day for each weekday (Mon..Sun) of the range. Counted by when each prompt and event happened.
  scoped.get("/insights/activity", async (c) => {
    const { user, org } = c.var;
    const raw = c.req.query("days") ?? "";
    const days = Number(raw);
    if (!["7", "14", "28"].includes(raw)) {
      await metrics.capture("insights_rejected", user.id, { reason: "invalid_days" });
      return fail(c, 400, "invalid_days", "days must be 7, 14 or 28.");
    }
    const db = await opts.getDb();
    const rows = (await store.dailyActivity(db, org.id, utcDay(now()).start, days)).map((r) => ({
      ...r,
      tool_calls_per_prompt: r.prompts > 0 ? Math.round((r.tool_calls / r.prompts) * 100) / 100 : null,
    }));
    const [orgSessions] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sesh.sessions WHERE org_id = $1`, [
      org.id,
    ]);
    // Mon..Sun averages per day over the range: the sum on those days / how many of them the range holds (zero days count).
    const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const by_dow = WEEKDAYS.map((dow, i) => {
      const mine = rows.filter((r) => (new Date(`${r.day}T00:00:00Z`).getUTCDay() + 6) % 7 === i);
      const avg = (pick: (r: (typeof rows)[number]) => number) =>
        mine.length ? round2(mine.reduce((sum, r) => sum + pick(r), 0) / mine.length) : 0;
      const tool_calls = avg((r) => r.tool_calls);
      const prompts = avg((r) => r.prompts);
      return {
        dow,
        tool_calls,
        prompts,
        active_sessions: avg((r) => r.active_sessions),
        tool_calls_per_prompt: prompts > 0 ? round2(tool_calls / prompts) : null,
      };
    });
    const last = rows.at(-1)!;
    const today = {
      tool_calls: last.tool_calls,
      prompts: last.prompts,
      active_sessions: last.active_sessions,
      tool_calls_per_prompt: last.tool_calls_per_prompt,
    };
    await metrics.capture("insights_viewed", user.id, {
      days,
      empty: rows.every((r) => !r.prompts && !r.tool_calls),
      org_empty: Number(orgSessions!.n) === 0,
    });
    return c.json({ days: rows, by_dow, today, org_sessions: Number(orgSessions!.n) });
  });

  // The team's 7 day pace (see store.poolPace) at the end of each of the last 7, 14 or 28 UTC days, oldest first;
  // null on a day where nothing was expected. Names no one.
  scoped.get("/insights/pace", async (c) => {
    const { user, org } = c.var;
    const raw = c.req.query("days") ?? "";
    if (!["7", "14", "28"].includes(raw)) {
      await metrics.capture("insights_pace_rejected", user.id, { reason: "invalid_days" });
      return fail(c, 400, "invalid_days", "days must be 7, 14 or 28.");
    }
    const days = await store.planPace(await opts.getDb(), org.id, utcDay(now()).start, Number(raw), now());
    await metrics.capture("insights_pace_viewed", user.id, {
      days: Number(raw),
      empty: days.every((d) => d.seven_day_pace === null),
    });
    return c.json({ days: days.map((d) => ({ day: d.day, pace: d.seven_day_pace })) });
  });

  // How many members reached the 5h limit (a snapshot at 100% or more) on each of the last 7, 14 or 28 UTC days,
  // oldest first, zero-filled; the last day is today. Counts only. Names no one.
  scoped.get("/insights/limit-hits", async (c) => {
    const { user, org } = c.var;
    const raw = c.req.query("days") ?? "";
    if (!["7", "14", "28"].includes(raw)) {
      await metrics.capture("insights_limit_hits_rejected", user.id, { reason: "invalid_days" });
      return fail(c, 400, "invalid_days", "days must be 7, 14 or 28.");
    }
    const days = await store.limitHits(await opts.getDb(), org.id, utcDay(now()).start, Number(raw));
    await metrics.capture("insights_limit_hits_viewed", user.id, {
      days: Number(raw),
      empty: days.every((d) => d.members === 0),
    });
    return c.json({ days });
  });

  // The org's members, by name and role, with `you` on the signed-in user's row.
  scoped.get("/members", async (c) => {
    const { user, org } = c.var;
    await metrics.capture("members_viewed", user.id);
    return c.json({ members: await store.listMembers(await opts.getDb(), org.id, user.id) });
  });

  // One session with its prompts and events. A session of another org is a 404, the same as one that doesn't exist.
  scoped.get("/sessions/:id", async (c) => {
    const { user, org } = c.var;
    const id = c.req.param("id");
    const found = UUID_RE.test(id) ? await store.getSession(await opts.getDb(), org.id, id) : undefined;
    if (!found) {
      await metrics.capture("session_detail_not_found", user.id, { malformed_id: !UUID_RE.test(id) });
      return fail(c, 404, "session_not_found", "No such session.");
    }
    await metrics.capture("session_detail_viewed", user.id, {
      prompts: found.prompts.length,
      events: found.events.length,
    });
    const { session, prompts, events } = found;
    return c.json({
      session: { ...session, started_at: session.started_at.toISOString() },
      prompts: prompts.map((p) => ({
        ...p,
        started_at: p.started_at.toISOString(),
        events: events.filter((e) => e.prompt_id === p.id).map(publicEvent),
      })),
      // Events that belong to no prompt (Claude Code didn't say which prompt caused them).
      unattributed_events: events.filter((e) => !e.prompt_id).map(publicEvent),
    });
  });

  scoped.post("/orgs", async (c) => {
    const user = c.var.user;
    const name = field(await jsonBody(c), "name");
    if (!name || name.length > MAX_ORG_NAME) {
      await metrics.capture("org_create_rejected", user.id, { reason: name ? "name_too_long" : "empty_name" });
      return fail(
        c,
        400,
        name ? "name_too_long" : "empty_name",
        `Give the org a name of up to ${MAX_ORG_NAME} characters.`,
      );
    }
    const org = await store.createOrg(await opts.getDb(), user.id, name);
    await metrics.capture("org_created", user.id);
    return c.json({ org: { ...publicOrg(org), role: "owner" } }, 201);
  });

  scoped.post("/orgs/switch", async (c) => {
    const user = c.var.user;
    const wanted = field(await jsonBody(c), "org");
    const target = c.var.orgs.find((o) => o.id === wanted);
    if (!target) {
      await metrics.capture("org_switch_rejected", user.id, { reason: "not_a_member" });
      return fail(c, 403, "not_a_member", "You aren't a member of that org.");
    }
    await metrics.capture("org_switched", user.id);
    return c.json({ org: membership(target) });
  });

  // Invites are always for the active org, so there is no org id to tamper with.
  scoped.post("/orgs/invite", async (c) => {
    const { user, org } = c.var;
    const email = field(await jsonBody(c), "email").toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 320) {
      await metrics.capture("invite_create_rejected", user.id, { reason: "invalid_email" });
      return fail(c, 400, "invalid_email", "That doesn't look like an email address.");
    }
    const made = await store.createInvite(await opts.getDb(), user.id, org.id);
    if ("problem" in made) {
      await metrics.capture("invite_create_rejected", user.id, { reason: made.problem });
      return made.problem === "not_owner"
        ? fail(c, 403, made.problem, "Only owners can invite people.")
        : fail(c, 429, made.problem, "You've sent a lot of invites today. Try again tomorrow.");
    }
    await metrics.capture("invite_created", user.id);
    try {
      await sendEmail({
        to: email,
        subject: `Join ${org.name} on sesh`,
        text: `${user.name} invited you to ${org.name} on sesh.\n\nSign in and join: ${new URL(c.req.url).origin}/invite/${made.token}\n\nThe link works once and expires in ${store.INVITE_TTL_DAYS} days.`,
      });
    } catch (err) {
      await metrics.capture("invite_email_failed", user.id);
      throw err;
    }
    return c.json({ email, ttl_days: store.INVITE_TTL_DAYS }, 201);
  });

  // Whether the signed-in user counts toward the active org's team. Off makes them an observer and revokes their tokens.
  scoped.post("/membership", async (c) => {
    const { user, org } = c.var;
    const counts = (await jsonBody(c)).counts_toward_team;
    if (typeof counts !== "boolean") {
      await metrics.capture("team_membership_rejected", user.id, { reason: "invalid_value" });
      return fail(c, 400, "invalid_value", "Say whether you count toward the team: true or false.");
    }
    const set = await store.setCountsTowardTeam(await opts.getDb(), user.id, org.id, counts);
    if (!set) {
      await metrics.capture("team_membership_rejected", user.id, { reason: "not_a_member" });
      return fail(c, 404, "not_a_member", "You aren't in that org.");
    }
    await metrics.capture(counts ? "team_count_enabled" : "team_observer_set", user.id, {
      tokens_revoked: set.revoked,
    });
    return c.json({ counts_toward_team: counts, tokens_revoked: set.revoked });
  });

  // Ingest tokens belong to the signed-in user and the active org, so there is no org id to tamper with.
  scoped.get("/tokens", async (c) => {
    const { user, org } = c.var;
    const tokens = await store.listIngestTokens(await opts.getDb(), user.id, org.id);
    return c.json({ tokens: tokens.map((t) => ({ id: t.id, name: t.name, created_at: t.created_at })) });
  });

  scoped.post("/tokens", async (c) => {
    const { user, org } = c.var;
    const name = field(await jsonBody(c), "name");
    if (!name || name.length > MAX_TOKEN_NAME) {
      await metrics.capture("token_create_rejected", user.id, { reason: name ? "name_too_long" : "empty_name" });
      return fail(
        c,
        400,
        name ? "name_too_long" : "empty_name",
        `Give the token a name of up to ${MAX_TOKEN_NAME} characters.`,
      );
    }
    const made = await store.createIngestToken(await opts.getDb(), user.id, org.id, name);
    if (!made) {
      await metrics.capture("token_create_rejected", user.id, { reason: "observer" });
      return fail(
        c,
        403,
        "observer",
        `You're an observer in ${org.name}, so you can't send it data. Count yourself toward the team first.`,
      );
    }
    await metrics.capture("token_created", user.id);
    // Shown on this response only: it is stored hashed.
    return c.json({ id: made.id, name, token: made.token }, 201);
  });

  scoped.post("/tokens/:id/revoke", async (c) => {
    const { user, org } = c.var;
    const id = c.req.param("id");
    const revoked = UUID_RE.test(id) && (await store.revokeIngestToken(await opts.getDb(), user.id, org.id, id));
    if (!revoked) {
      await metrics.capture("token_revoke_rejected", user.id, { reason: "not_found" });
      return fail(c, 404, "not_found", "That token doesn't exist or was already revoked.");
    }
    await metrics.capture("token_revoked", user.id);
    return c.json({ ok: true });
  });

  api.route("/", scoped);
  api.all("*", (c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));
  app.route("/api", api);

  // OTLP/HTTP ingest. The bearer token says which org and user the payload is for; the body is stored as it came.
  const ingest = (signal: store.Signal) => async (c: Context) => {
    const reject = async (status: 401 | 413 | 415 | 400, reason: string, distinctId = ANONYMOUS) => {
      await metrics.capture("ingest_rejected", distinctId, { signal, reason });
      return c.json({ error: reason }, status, status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
    };
    const header = c.req.header("authorization") ?? "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!bearer) return reject(401, "missing_token");
    const db = await opts.getDb();
    const who = await store.findIngestToken(db, bearer);
    if (!who) return reject(401, "invalid_token");

    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const encoding = c.req.header("content-encoding")?.trim().toLowerCase();
    const format =
      contentType === "application/json" ? "json" : contentType === "application/x-protobuf" ? "protobuf" : "";
    if (!format || (encoding && encoding !== "identity" && encoding !== "gzip"))
      return reject(415, format ? "unsupported_encoding" : "unsupported_content_type", who.userId);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_INGEST_BYTES) return reject(413, "payload_too_large", who.userId);
    const body = await readCapped(c.req.raw.body, MAX_INGEST_BYTES);
    if (!body) return reject(413, "payload_too_large", who.userId);
    if (!body.length) return reject(400, "empty_body", who.userId);
    if (format === "json" && (!encoding || encoding === "identity")) {
      try {
        JSON.parse(new TextDecoder().decode(body));
      } catch {
        return reject(400, "invalid_json", who.userId);
      }
    }

    const payloadId = await store.storeRawPayload(db, {
      ...who,
      signal,
      contentType,
      contentEncoding: encoding === "gzip" ? "gzip" : undefined,
      body,
    });
    await metrics.capture("ingest_accepted", who.userId, { signal, format, gzip: encoding === "gzip" });
    // Parse logs right away, then sweep up any earlier payload whose parse failed. The raw payload is already safe,
    // so a failure here is only counted. A backfill upload gets the turn counts of its own payload back, which
    // `sesh upload` prints (not the swept ones, which may be another org's); live payloads get `{}`.
    let backfillTurns: { turns_accepted: number; turns_skipped: number } | undefined;
    if (signal === "logs") {
      try {
        const own = await parsePending(db, payloadId);
        if (own.turnsAccepted || own.turnsSkipped)
          backfillTurns = { turns_accepted: own.turnsAccepted, turns_skipped: own.turnsSkipped };
        const swept = await parsePending(db);
        const r = {
          parsed: own.parsed + swept.parsed,
          skipped: own.skipped + swept.skipped,
          backfillSkipped: own.backfillSkipped + swept.backfillSkipped,
          failed: own.failed + swept.failed,
        };
        if (r.backfillSkipped)
          await metrics.capture("backfill_records_skipped", who.userId, {
            reason: "turn_already_stored",
            count: r.backfillSkipped,
          });
        if (r.failed) await metrics.capture("payload_parse_failed", who.userId, { format, count: r.failed });
        else
          await metrics.capture("payload_parsed", who.userId, {
            outcome: r.skipped ? "skipped_unreadable" : "parsed",
            format,
          });
      } catch (err) {
        console.error("parse failed:", err);
        await metrics.capture("payload_parse_failed", who.userId, { format, count: 1 });
      }
    }
    // Plan usage gauges in a metrics payload become limit snapshots. The raw payload is already safe, so a failure is
    // only counted.
    if (signal === "metrics") {
      try {
        const json = decodeJsonPayload(body, contentType, encoding === "gzip" ? "gzip" : undefined);
        const readings = json === undefined ? [] : parsePlanUsage(json);
        for (const r of readings) await store.storeLimitSnapshot(db, who, r);
        if (readings.length) await metrics.capture("plan_usage_ingested", who.userId, { readings: readings.length });
      } catch (err) {
        console.error("plan usage parse failed:", err);
        await metrics.capture("plan_usage_parse_failed", who.userId, { format });
      }
    }
    // An OTLP success response: `{}` for JSON (plus the backfill counts above), zero bytes for protobuf.
    return format === "json"
      ? c.json(backfillTurns ? { sesh: backfillTurns } : {})
      : c.body(null, 200, { "content-type": "application/x-protobuf" });
  };
  // Plan usage from the status line script. Only the session id, the two windows and the time are kept.
  app.post("/v1/limits", async (c) => {
    const reject = async (status: 400 | 401 | 413, reason: string, distinctId = ANONYMOUS) => {
      await metrics.capture("limits_rejected", distinctId, { reason });
      return c.json({ error: reason }, status, status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
    };
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!bearer) return reject(401, "missing_token");
    const db = await opts.getDb();
    const who = await store.findIngestToken(db, bearer);
    if (!who) return reject(401, "invalid_token");
    if (Number(c.req.header("content-length") ?? 0) > MAX_LIMITS_BYTES)
      return reject(413, "payload_too_large", who.userId);
    const body = await jsonBody(c);
    const sessionId = field(body, "session_id");
    if (!sessionId || sessionId.length > 200) return reject(400, "invalid_session_id", who.userId);
    const windows = {
      fiveHourPct: percent(body.five_hour_pct),
      sevenDayPct: percent(body.seven_day_pct),
      fiveHourResetsAt: unixTime(body.five_hour_resets_at),
      sevenDayResetsAt: unixTime(body.seven_day_resets_at),
    };
    if (Object.values(windows).some((v) => v === "invalid")) return reject(400, "invalid_value", who.userId);
    const { fiveHourPct, sevenDayPct, fiveHourResetsAt, sevenDayResetsAt } = windows as {
      [K in keyof typeof windows]: Exclude<(typeof windows)[K], "invalid">;
    };
    if (fiveHourPct == null && sevenDayPct == null) return reject(400, "no_percentages", who.userId);
    const capturedAt = new Date(typeof body.captured_at === "string" ? body.captured_at : NaN);
    if (Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > Date.now() + MAX_CLOCK_SKEW_MS)
      return reject(400, "invalid_captured_at", who.userId);
    await store.storeLimitSnapshot(db, who, {
      sessionId,
      fiveHourPct,
      fiveHourResetsAt,
      sevenDayPct,
      sevenDayResetsAt,
      capturedAt,
    });
    await metrics.capture("limits_accepted", who.userId, {
      has_five_hour: fiveHourPct != null,
      has_seven_day: sevenDayPct != null,
    });
    return c.json({});
  });
  app.post("/v1/logs", ingest("logs"));
  app.post("/v1/metrics", ingest("metrics"));

  return app;
}
