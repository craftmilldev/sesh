import type { Db } from "./db/index.js";
import { newIngestToken, newInviteToken, newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Org {
  id: string;
  name: string;
}

export type Role = "owner" | "member";
export interface Membership extends Org {
  role: Role;
  /** False for an observer: in the org to look, but not part of the team's pool and not sending data. */
  counts_toward_team: boolean;
}

export const INVITE_TTL_DAYS = 7;

export const LOGIN_CODE_TTL_MINUTES = 10;
const MAX_LOGIN_ATTEMPTS = 5;

export async function findUserById(db: Db, id: string): Promise<User | undefined> {
  const [user] = await db.query<User>(`SELECT id, name, email FROM sesh.users WHERE id = $1`, [id]);
  return user;
}

/** The org a user owns and lands in. Sign-in creates it with the user, so every user has one. */
export async function personalOrg(db: Db, userId: string): Promise<Org | undefined> {
  const [org] = await db.query<Org>(`SELECT id, name FROM sesh.orgs WHERE personal_user_id = $1`, [userId]);
  return org;
}

/**
 * Starts a login for this email, whether or not it belongs to a user yet (redeeming the code creates the user).
 * `code` is undefined when one was already issued and hasn't expired: one email per address per TTL,
 * so this can't be used to spam anyone.
 */
export async function createLoginCode(db: Db, email: string): Promise<{ email: string; code?: string }> {
  const addr = email.toLowerCase();
  const code = newLoginCode();
  // email is unique, so concurrent requests can't both get a code.
  await db.query(`DELETE FROM sesh.login_codes WHERE email = $1 AND expires_at <= now()`, [addr]);
  const issued = await db.query(
    `INSERT INTO sesh.login_codes (id, email, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + $4::int * interval '1 minute')
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [uuidv7(), addr, sha256(code), LOGIN_CODE_TTL_MINUTES],
  );
  return { email: addr, code: issued.length ? code : undefined };
}

export type RedeemResult = { ok: true; user: User; created: boolean } | { ok: false; problem: "invalid_code" };

/**
 * Trades a valid, unexpired code for the user. An email with no user gets one, with a personal org they own, created
 * together in one transaction with the code's use. The user is named after the part of the email before the @.
 * Codes are single-use and die after too many wrong guesses.
 */
export async function redeemLoginCode(db: Db, email: string, code: string): Promise<RedeemResult> {
  const addr = email.toLowerCase();
  const [row] = await db.query<{ id: string; code_hash: string }>(
    `UPDATE sesh.login_codes SET attempts = attempts + 1
     WHERE email = $1 AND expires_at > now() AND attempts < $2
     RETURNING id, code_hash`,
    [addr, MAX_LOGIN_ATTEMPTS],
  );
  if (!row || !safeEqual(row.code_hash, sha256(normalizeLoginCode(code))))
    return { ok: false, problem: "invalid_code" };
  return db.transaction(async (tx) => {
    const [used] = await tx.query<{ id: string }>(`DELETE FROM sesh.login_codes WHERE id = $1 RETURNING id`, [row.id]);
    if (!used) return { ok: false as const, problem: "invalid_code" as const };
    const [existing] = await tx.query<User>(`SELECT id, name, email FROM sesh.users WHERE lower(email) = $1`, [addr]);
    if (existing) return { ok: true as const, user: existing, created: false };
    const name = addr.split("@")[0]!;
    const [user] = await tx.query<User>(
      `INSERT INTO sesh.users (id, name, email) VALUES ($1, $2, $3) RETURNING id, name, email`,
      [uuidv7(), name, addr],
    );
    const orgId = uuidv7();
    await tx.query(`INSERT INTO sesh.orgs (id, name, personal_user_id) VALUES ($1, $2, $3)`, [orgId, name, user!.id]);
    await tx.query(
      `INSERT INTO sesh.org_members (org_id, user_id, role, counts_toward_team) VALUES ($1, $2, 'owner', true)`,
      [orgId, user!.id],
    );
    return { ok: true as const, user: user!, created: true };
  });
}

/** Every org the user belongs to, oldest first, with their role in it. */
export async function userOrgs(db: Db, userId: string): Promise<Membership[]> {
  return db.query<Membership>(
    `SELECT o.id, o.name, m.role, m.counts_toward_team FROM sesh.org_members m JOIN sesh.orgs o ON o.id = m.org_id
     WHERE m.user_id = $1 ORDER BY o.id`,
    [userId],
  );
}

/** Creates an org with the user as its owner. */
export async function createOrg(db: Db, userId: string, name: string): Promise<Org> {
  return db.transaction(async (tx) => {
    const [org] = await tx.query<Org>(`INSERT INTO sesh.orgs (id, name) VALUES ($1, $2) RETURNING id, name`, [
      uuidv7(),
      name,
    ]);
    await tx.query(
      `INSERT INTO sesh.org_members (org_id, user_id, role, counts_toward_team) VALUES ($1, $2, 'owner', true)`,
      [org!.id, userId],
    );
    return org!;
  });
}

/** The most invites one owner can send in a day, so the invite email can't be used to spam. */
export const MAX_INVITES_PER_DAY = 20;

export type CreateInviteResult = { ok: true; token: string } | { ok: false; problem: "not_owner" | "rate_limited" };

/** Makes a one-use invite token for an org. Only an owner can, and only up to a daily cap. */
export async function createInvite(db: Db, userId: string, orgId: string): Promise<CreateInviteResult> {
  const [owner] = await db.query(
    `SELECT 1 FROM sesh.org_members WHERE org_id = $1 AND user_id = $2 AND role = 'owner'`,
    [orgId, userId],
  );
  if (!owner) return { ok: false, problem: "not_owner" };
  const token = newInviteToken();
  const made = await db.query(
    `INSERT INTO sesh.org_invites (id, org_id, token_hash, created_by, expires_at)
     SELECT $1, $3, $2, $4, now() + $5::int * interval '1 day'
     WHERE (SELECT count(*) FROM sesh.org_invites WHERE created_by = $4 AND created_at > now() - interval '1 day') < $6
     RETURNING id`,
    [uuidv7(), sha256(token), orgId, userId, INVITE_TTL_DAYS, MAX_INVITES_PER_DAY],
  );
  return made.length ? { ok: true, token } : { ok: false, problem: "rate_limited" };
}

export type InviteLookup = { ok: true; org: Org } | { ok: false; problem: "unknown" | "used" | "expired" };

export async function findInvite(db: Db, token: string): Promise<InviteLookup> {
  const [row] = await db.query<{ id: string; name: string; used: boolean; expired: boolean }>(
    `SELECT o.id, o.name, i.used_at IS NOT NULL AS used, i.expires_at <= now() AS expired
     FROM sesh.org_invites i JOIN sesh.orgs o ON o.id = i.org_id WHERE i.token_hash = $1`,
    [sha256(token)],
  );
  if (!row) return { ok: false, problem: "unknown" };
  if (row.used) return { ok: false, problem: "used" };
  if (row.expired) return { ok: false, problem: "expired" };
  return { ok: true, org: { id: row.id, name: row.name } };
}

export type AcceptResult =
  { ok: true; org: Org; alreadyMember: boolean } | { ok: false; problem: "unknown" | "used" | "expired" };

/** Spends an invite and makes the user a member. Someone already in the org joins nothing and the invite is kept. */
export async function acceptInvite(db: Db, userId: string, token: string): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const [inv] = await tx.query<{ id: string; org_id: string; name: string; used: boolean; expired: boolean }>(
      `SELECT i.id, i.org_id, o.name, i.used_at IS NOT NULL AS used, i.expires_at <= now() AS expired
       FROM sesh.org_invites i JOIN sesh.orgs o ON o.id = i.org_id WHERE i.token_hash = $1 FOR UPDATE OF i`,
      [sha256(token)],
    );
    if (!inv) return { ok: false as const, problem: "unknown" as const };
    if (inv.used) return { ok: false as const, problem: "used" as const };
    if (inv.expired) return { ok: false as const, problem: "expired" as const };
    const org = { id: inv.org_id, name: inv.name };
    const [member] = await tx.query(`SELECT 1 FROM sesh.org_members WHERE org_id = $1 AND user_id = $2`, [
      org.id,
      userId,
    ]);
    if (member) return { ok: true as const, org, alreadyMember: true };
    await tx.query(`UPDATE sesh.org_invites SET used_by = $1, used_at = now() WHERE id = $2`, [userId, inv.id]);
    await tx.query(`INSERT INTO sesh.org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [org.id, userId]);
    return { ok: true as const, org, alreadyMember: false };
  });
}

export interface IngestToken {
  id: string;
  name: string;
  created_at: Date;
}

/**
 * Makes a token for the user in an org they belong to. Returns the secret once; only its hash is stored.
 * An observer (not counted toward the team) gets nothing: they can't send data to the org.
 */
export async function createIngestToken(
  db: Db,
  userId: string,
  orgId: string,
  name: string,
): Promise<{ id: string; token: string } | undefined> {
  const token = newIngestToken();
  const id = uuidv7();
  const made = await db.query(
    `INSERT INTO sesh.ingest_tokens (id, org_id, user_id, name, token_hash)
     SELECT $1, $2, $3, $4, $5
     WHERE EXISTS (SELECT 1 FROM sesh.org_members WHERE org_id = $2 AND user_id = $3 AND counts_toward_team)
     RETURNING id`,
    [id, orgId, userId, name, sha256(token)],
  );
  return made.length ? { id, token } : undefined;
}

/**
 * Sets whether the user counts toward the org's team. Turning it off revokes their tokens for the org, so nothing
 * more reaches it. Returns how many tokens that revoked, or undefined when they aren't in the org.
 */
export async function setCountsTowardTeam(
  db: Db,
  userId: string,
  orgId: string,
  counts: boolean,
): Promise<{ revoked: number } | undefined> {
  return db.transaction(async (tx) => {
    const set = await tx.query(
      `UPDATE sesh.org_members SET counts_toward_team = $3 WHERE org_id = $1 AND user_id = $2 RETURNING user_id`,
      [orgId, userId, counts],
    );
    if (!set.length) return undefined;
    if (counts) return { revoked: 0 };
    const revoked = await tx.query(
      `UPDATE sesh.ingest_tokens SET revoked_at = now()
       WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [orgId, userId],
    );
    return { revoked: revoked.length };
  });
}

/** The user's live (not revoked) tokens for an org, newest first. */
export async function listIngestTokens(db: Db, userId: string, orgId: string): Promise<IngestToken[]> {
  return db.query<IngestToken>(
    `SELECT id, name, created_at FROM sesh.ingest_tokens
     WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL ORDER BY id DESC`,
    [userId, orgId],
  );
}

/** Revokes one of the user's own tokens. False when it isn't theirs, isn't in this org or was already revoked. */
export async function revokeIngestToken(db: Db, userId: string, orgId: string, id: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE sesh.ingest_tokens SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND org_id = $3 AND revoked_at IS NULL RETURNING id`,
    [id, userId, orgId],
  );
  return rows.length > 0;
}

/** Who a bearer token speaks for. Revoked tokens, and tokens of users no longer in the org or not counted toward its team, match nothing. */
export async function findIngestToken(db: Db, token: string): Promise<{ orgId: string; userId: string } | undefined> {
  const [row] = await db.query<{ org_id: string; user_id: string }>(
    `SELECT t.org_id, t.user_id FROM sesh.ingest_tokens t
     JOIN sesh.org_members m ON m.org_id = t.org_id AND m.user_id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND m.counts_toward_team`,
    [sha256(token)],
  );
  return row && { orgId: row.org_id, userId: row.user_id };
}

export type Signal = "logs" | "metrics";

/** Stores an accepted OTLP request exactly as it arrived, for the parsing step to read later. */
export async function storeRawPayload(
  db: Db,
  p: { orgId: string; userId: string; signal: Signal; contentType: string; contentEncoding?: string; body: Uint8Array },
): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO sesh.raw_payloads (id, org_id, user_id, signal, content_type, content_encoding, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, p.orgId, p.userId, p.signal, p.contentType, p.contentEncoding ?? null, Buffer.from(p.body)],
  );
  return id;
}

export interface LimitSnapshot {
  sessionId: string;
  fiveHourPct: number | null;
  fiveHourResetsAt: Date | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: Date | null;
  capturedAt: Date;
}

/** Stores one status line reading for the token's org and user. */
export async function storeLimitSnapshot(db: Db, who: { orgId: string; userId: string }, s: LimitSnapshot) {
  await db.query(
    `INSERT INTO sesh.limit_snapshots
       (id, org_id, user_id, session_external_id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidv7(),
      who.orgId,
      who.userId,
      s.sessionId,
      s.fiveHourPct,
      s.fiveHourResetsAt,
      s.sevenDayPct,
      s.sevenDayResetsAt,
      s.capturedAt,
    ],
  );
}

export interface UserLimits {
  user_name: string;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  /** When the member's current 7 day window ends; null when they have never reported one. */
  seven_day_resets_at: Date | null;
  captured_at: Date;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Each team member's current plan usage (observers are left out). An idle session's status line keeps posting the last reading it saw, so the
 * latest snapshot can be stale; usage only rises until the window resets, so a window's usage is its highest
 * reading. A window that has already reset (its resets_at is past) counts as unknown. A 7 day window resets at
 * the same time each week, so a past reset is rolled forward by whole weeks to give the current window's end.
 * `now` is "as of": only readings captured up to then count.
 */
export async function currentLimits(db: Db, orgId: string, now = new Date()): Promise<UserLimits[]> {
  const rows = await db.query<{
    user_name: string;
    five_hour_pct: number | null;
    seven_day_pct: number | null;
    seven_day_resets_at: Date | null;
    captured_at: Date;
  }>(
    `SELECT u.name AS user_name,
            max(l.five_hour_pct) FILTER (WHERE l.five_hour_resets_at > $2) AS five_hour_pct,
            max(l.seven_day_pct) FILTER (WHERE l.seven_day_resets_at > $2) AS seven_day_pct,
            max(l.seven_day_resets_at) AS seven_day_resets_at,
            max(l.captured_at) AS captured_at
     FROM sesh.users u
     JOIN sesh.org_members m ON m.org_id = $1 AND m.user_id = u.id AND m.counts_toward_team
     JOIN sesh.limit_snapshots l ON l.user_id = u.id
     WHERE l.org_id = $1 AND l.captured_at <= $2 AND l.captured_at > $2::timestamptz - interval '28 days'
     GROUP BY u.id, u.name
     ORDER BY u.name, u.id`,
    [orgId, now],
  );
  return rows.map((r) => {
    let resets = r.seven_day_resets_at == null ? null : new Date(r.seven_day_resets_at).getTime();
    if (resets != null && resets <= now.getTime())
      resets += Math.ceil((now.getTime() - resets + 1) / WEEK_MS) * WEEK_MS;
    return {
      ...r,
      five_hour_pct: r.five_hour_pct == null ? null : Number(r.five_hour_pct),
      seven_day_pct: r.seven_day_pct == null ? null : Number(r.seven_day_pct),
      seven_day_resets_at: resets == null ? null : new Date(resets),
      captured_at: new Date(r.captured_at),
    };
  });
}

/** Milliseconds of weekday (Monday to Friday, UTC) time from `from` to `to`. */
export function weekdayMs(from: Date, to: Date): number {
  let ms = 0;
  for (let t = from.getTime(); t < to.getTime();) {
    const d = new Date(t);
    const end = Math.min(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1), to.getTime());
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) ms += end - t;
    t = end;
  }
  return ms;
}

/**
 * How much of a 7 day window (percent) should be used by `now` to use all of it by the reset, at an even pace
 * over its weekdays and nothing on Saturday and Sunday (UTC). Every 7 day window holds exactly 5 weekdays, so
 * this is 20% a weekday, flat over the weekend.
 */
export function expectedUsed(resetsAt: Date, now: Date): number {
  const start = new Date(resetsAt.getTime() - WEEK_MS);
  if (now <= start) return 0;
  if (now >= resetsAt) return 100;
  return (100 * weekdayMs(start, now)) / (5 * DAY_MS);
}

/** An org's members, owners first. `you` marks `userId`'s own row. */
export async function listMembers(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ name: string; role: Role; counts_toward_team: boolean; you: boolean }[]> {
  return db.query<{ name: string; role: Role; counts_toward_team: boolean; you: boolean }>(
    `SELECT u.name, m.role, m.counts_toward_team, (m.user_id = $2) AS you
     FROM sesh.org_members m JOIN sesh.users u ON u.id = m.user_id
     WHERE m.org_id = $1 ORDER BY (m.role = 'owner') DESC, m.created_at, u.id`,
    [orgId, userId],
  );
}

export interface PlanPool {
  members: number;
  five_hour_used: number;
  seven_day_used: number;
  five_hour_reporting: number;
  seven_day_reporting: number;
  /** The share of the 7 day pool that would be used by now at 20% a weekday (see expectedUsed). */
  seven_day_expected: number;
  /** 7 day usage against that even pace, percent (100 is right on pace); null when nothing is expected yet. */
  seven_day_pace: number | null;
}

const clampPct = (u: number) => Math.min(100, Math.max(0, u));

/**
 * The team's plan window as one pool: every member counted toward the team (not observers) is an equal 1/N share of 100%, a member's share used is their
 * current reading, and a member with none (never reported, or the window has reset) counts as 0% used.
 */
export function poolUsed(used: number[], members: number): number {
  if (members <= 0) return 0;
  const sum = used.reduce((a, u) => a + clampPct(u), 0);
  return Math.round(sum / members);
}

/**
 * The team's 7 day pace: what members with a known window have used against what an even weekday pace would
 * have them at by now. Members who have never reported have no known window and are left out.
 */
export function poolPace(windows: { used: number; resetsAt: Date }[], members: number, now: Date) {
  const expected = windows.reduce((a, w) => a + expectedUsed(w.resetsAt, now), 0);
  const used = windows.reduce((a, w) => a + clampPct(w.used), 0);
  return {
    seven_day_expected: members > 0 ? Math.round(expected / members) : 0,
    seven_day_pace: expected > 0 ? Math.round((100 * used) / expected) : null,
  };
}

export async function planPool(db: Db, orgId: string, now = new Date()): Promise<PlanPool> {
  const [row] = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM sesh.org_members WHERE org_id = $1 AND counts_toward_team`,
    [orgId],
  );
  const members = Number(row!.n);
  const limits = await currentLimits(db, orgId, now);
  const five = limits.map((l) => l.five_hour_pct).filter((v) => v != null);
  const seven = limits.map((l) => l.seven_day_pct).filter((v) => v != null);
  const windows = limits.flatMap((l) =>
    l.seven_day_resets_at ? [{ used: l.seven_day_pct ?? 0, resetsAt: l.seven_day_resets_at }] : [],
  );
  return {
    members,
    five_hour_used: poolUsed(five, members),
    seven_day_used: poolUsed(seven, members),
    five_hour_reporting: five.length,
    seven_day_reporting: seven.length,
    ...poolPace(windows, members, now),
  };
}

/**
 * The team's 7 day pace as it stood at the end of each of `days` UTC days ending with the one that starts at
 * `lastStart` (oldest first): the last millisecond of the day, or `now` for the last day. Each day is planPool as of
 * then, so only readings captured by that moment count. Null where nothing is expected.
 */
export async function planPace(db: Db, orgId: string, lastStart: Date, days: number, now: Date) {
  const rows: { day: string; seven_day_pace: number | null }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(lastStart.getTime() - i * DAY_MS);
    const asOf = i === 0 ? now : new Date(start.getTime() + DAY_MS - 1);
    rows.push({
      day: start.toISOString().slice(0, 10),
      seven_day_pace: (await planPool(db, orgId, asOf)).seven_day_pace,
    });
  }
  return rows;
}

/**
 * For each of `days` UTC days ending with the one that starts at `lastStart` (oldest first, zero-filled): how many
 * distinct members have a snapshot captured that day whose 5h used percent reached 100. Counts only; it names no one.
 */
export async function limitHits(db: Db, orgId: string, lastStart: Date, days: number) {
  const first = new Date(lastStart.getTime() - (days - 1) * DAY_MS);
  const rows = await db.query<{ day: string; n: string }>(
    `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(DISTINCT user_id) AS n
     FROM sesh.limit_snapshots
     WHERE org_id = $1 AND captured_at >= $2 AND captured_at < $3 AND five_hour_pct >= 100
     GROUP BY 1`,
    [orgId, first, new Date(lastStart.getTime() + DAY_MS)],
  );
  const byDay = new Map(rows.map((r) => [r.day, Number(r.n)]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(first.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    return { day, members: byDay.get(day) ?? 0 };
  });
}

export const SESSIONS_PAGE_SIZE = 25;

export interface SessionRow {
  id: string;
  user_name: string;
  started_at: Date;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  prompts: number;
  tool_calls: number;
  /** The session's latest plan usage, from its status line; null when it never posted one. */
  five_hour_pct: number | null;
  seven_day_pct: number | null;
}

const SESSION_SELECT = `SELECT s.id, u.name AS user_name, s.started_at,
            COALESCE(e.input_tokens, 0) AS input_tokens, COALESCE(e.output_tokens, 0) AS output_tokens,
            COALESCE(e.cache_read_tokens, 0) AS cache_read_tokens, COALESCE(e.cache_write_tokens, 0) AS cache_write_tokens,
            COALESCE(e.tool_calls, 0) AS tool_calls,
            (SELECT count(*) FROM sesh.prompts p WHERE p.session_id = s.id) AS prompts,
            l.five_hour_pct, l.seven_day_pct
     FROM sesh.sessions s
     JOIN sesh.users u ON u.id = s.user_id
     LEFT JOIN LATERAL (
       SELECT sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
              sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
              count(*) FILTER (WHERE kind = 'tool_call') AS tool_calls
       FROM sesh.events WHERE session_id = s.id
     ) e ON true
     LEFT JOIN LATERAL (
       SELECT five_hour_pct, seven_day_pct FROM sesh.limit_snapshots
       WHERE org_id = s.org_id AND user_id = s.user_id AND session_external_id = s.external_id
       ORDER BY captured_at DESC LIMIT 1
     ) l ON s.agent = 'claude-code'`;

const sessionRow = (r: Record<keyof SessionRow, string | number | Date | null>): SessionRow => ({
  id: r.id as string,
  user_name: r.user_name as string,
  started_at: new Date(r.started_at as string | Date),
  input_tokens: Number(r.input_tokens),
  output_tokens: Number(r.output_tokens),
  cache_read_tokens: Number(r.cache_read_tokens),
  cache_write_tokens: Number(r.cache_write_tokens),
  prompts: Number(r.prompts),
  tool_calls: Number(r.tool_calls),
  five_hour_pct: r.five_hour_pct == null ? null : Number(r.five_hour_pct),
  seven_day_pct: r.seven_day_pct == null ? null : Number(r.seven_day_pct),
});

/** One page of the org's sessions, newest first, with the figures summed from their events and prompts. */
export async function listSessions(
  db: Db,
  orgId: string,
  page: number,
): Promise<{ sessions: SessionRow[]; total: number }> {
  const rows = await db.query<Record<keyof SessionRow, string | number | Date | null>>(
    `${SESSION_SELECT}
     WHERE s.org_id = $1
     ORDER BY s.started_at DESC, s.id DESC
     LIMIT $2 OFFSET $3`,
    [orgId, SESSIONS_PAGE_SIZE, (page - 1) * SESSIONS_PAGE_SIZE],
  );
  const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sesh.sessions WHERE org_id = $1`, [orgId]);
  return { total: Number(count!.n), sessions: rows.map(sessionRow) };
}

export interface EventRow {
  id: string;
  prompt_id: string | null;
  kind: "api_request" | "tool_call";
  occurred_at: Date;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  tool_name: string | null;
  success: boolean | null;
  raw: unknown;
}
export interface PromptRow {
  id: string;
  prompt_length: number | null;
  started_at: Date;
}

/** One of the org's sessions with all its prompts and events in time order; undefined when the org has no such session. */
export async function getSession(
  db: Db,
  orgId: string,
  sessionId: string,
): Promise<{ session: SessionRow; prompts: PromptRow[]; events: EventRow[] } | undefined> {
  const [row] = await db.query<Record<keyof SessionRow, string | number | Date | null>>(
    `${SESSION_SELECT} WHERE s.org_id = $1 AND s.id = $2`,
    [orgId, sessionId],
  );
  if (!row) return undefined;
  const prompts = await db.query<PromptRow>(
    `SELECT id, prompt_length, started_at FROM sesh.prompts WHERE session_id = $1 ORDER BY started_at, id`,
    [sessionId],
  );
  const events = await db.query<EventRow>(
    `SELECT id, prompt_id, kind, occurred_at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cost_usd, duration_ms, tool_name, success, raw
     FROM sesh.events WHERE session_id = $1 ORDER BY occurred_at, id`,
    [sessionId],
  );
  // Token counts are bigint columns, which arrive as strings.
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    session: sessionRow(row),
    prompts: prompts.map((p) => ({ ...p, started_at: new Date(p.started_at) })),
    events: events.map((e) => ({
      ...e,
      occurred_at: new Date(e.occurred_at),
      input_tokens: n(e.input_tokens),
      output_tokens: n(e.output_tokens),
      cache_read_tokens: n(e.cache_read_tokens),
      cache_write_tokens: n(e.cache_write_tokens),
      cost_usd: n(e.cost_usd),
      duration_ms: n(e.duration_ms),
    })),
  };
}

export interface DayTotals {
  sessions: number;
  tokens: number;
  cache_read_tokens: number;
  prompts: number;
  tool_calls: number;
}

export interface DayTop {
  id: string;
  started_at: Date;
  tokens: number;
  cache_read_tokens: number;
  prompts: number;
  tool_calls: number;
}

/**
 * What the org did in [since, until): its prompts and events with a timestamp in that range, summed, and the heaviest
 * `top` sessions by tokens in it. A session counts when it has any prompt or event in the range, whenever it started.
 */
export async function activityBetween(
  db: Db,
  orgId: string,
  since: Date,
  until: Date,
  top: number,
): Promise<{ totals: DayTotals; top: DayTop[]; orgSessions: number }> {
  const active = `SELECT s.id, s.started_at,
            COALESCE(e.tokens, 0) AS tokens, COALESCE(e.cache_read_tokens, 0) AS cache_read_tokens,
            COALESCE(e.tool_calls, 0) AS tool_calls, p.prompts
     FROM sesh.sessions s
     CROSS JOIN LATERAL (
       SELECT sum(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)) AS tokens,
              sum(cache_read_tokens) AS cache_read_tokens,
              count(*) FILTER (WHERE kind = 'tool_call') AS tool_calls, count(*) AS events
       FROM sesh.events WHERE session_id = s.id AND occurred_at >= $2 AND occurred_at < $3
     ) e
     CROSS JOIN LATERAL (
       SELECT count(*) AS prompts FROM sesh.prompts WHERE session_id = s.id AND started_at >= $2 AND started_at < $3
     ) p
     WHERE s.org_id = $1 AND (e.events > 0 OR p.prompts > 0)`;
  const [t] = await db.query<Record<keyof DayTotals, string>>(
    `SELECT count(*) AS sessions, COALESCE(sum(tokens), 0) AS tokens,
            COALESCE(sum(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(sum(prompts), 0) AS prompts, COALESCE(sum(tool_calls), 0) AS tool_calls
     FROM (${active}) t`,
    [orgId, since, until],
  );
  const rows = await db.query<Record<keyof DayTop, string | Date>>(
    `${active} ORDER BY tokens DESC, s.started_at DESC, s.id DESC LIMIT $4`,
    [orgId, since, until, top],
  );
  const [all] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sesh.sessions WHERE org_id = $1`, [orgId]);
  return {
    totals: {
      sessions: Number(t!.sessions),
      tokens: Number(t!.tokens),
      cache_read_tokens: Number(t!.cache_read_tokens),
      prompts: Number(t!.prompts),
      tool_calls: Number(t!.tool_calls),
    },
    top: rows.map((r) => ({
      id: r.id as string,
      started_at: new Date(r.started_at),
      tokens: Number(r.tokens),
      cache_read_tokens: Number(r.cache_read_tokens),
      prompts: Number(r.prompts),
      tool_calls: Number(r.tool_calls),
    })),
    orgSessions: Number(all!.n),
  };
}

export interface DayActivity {
  /** The UTC day, "YYYY-MM-DD". */
  day: string;
  tool_calls: number;
  prompts: number;
  /** Sessions with any prompt or event that day. */
  active_sessions: number;
}

/**
 * The org's activity for each of the `days` UTC days ending with the day that starts at `lastStart`: oldest first, a
 * zero row for a day with none. Counted by when each prompt and event happened, so a session spanning days is active on
 * each of them.
 */
export async function dailyActivity(db: Db, orgId: string, lastStart: Date, days: number): Promise<DayActivity[]> {
  const first = new Date(lastStart.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const end = new Date(lastStart.getTime() + 24 * 60 * 60 * 1000);
  const rows = await db.query<{ day: string; tool_calls: string; prompts: string; active_sessions: string }>(
    `WITH acts AS (
       SELECT e.session_id, e.occurred_at AS at, (e.kind = 'tool_call') AS tool_call, false AS prompt
       FROM sesh.events e JOIN sesh.sessions s ON s.id = e.session_id
       WHERE s.org_id = $1 AND e.occurred_at >= $2 AND e.occurred_at < $3
       UNION ALL
       SELECT p.session_id, p.started_at, false, true
       FROM sesh.prompts p JOIN sesh.sessions s ON s.id = p.session_id
       WHERE s.org_id = $1 AND p.started_at >= $2 AND p.started_at < $3
     ),
     per_day AS (
       SELECT (at AT TIME ZONE 'UTC')::date AS day,
              count(*) FILTER (WHERE tool_call) AS tool_calls, count(*) FILTER (WHERE prompt) AS prompts,
              count(DISTINCT session_id) AS active_sessions
       FROM acts GROUP BY 1
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(p.tool_calls, 0) AS tool_calls,
            COALESCE(p.prompts, 0) AS prompts, COALESCE(p.active_sessions, 0) AS active_sessions
     FROM generate_series(($2::timestamptz AT TIME ZONE 'UTC')::date, ($3::timestamptz AT TIME ZONE 'UTC')::date - 1, interval '1 day') AS d(day)
     LEFT JOIN per_day p ON p.day = d.day::date
     ORDER BY d.day`,
    [orgId, first, end],
  );
  return rows.map((r) => ({
    day: r.day,
    tool_calls: Number(r.tool_calls),
    prompts: Number(r.prompts),
    active_sessions: Number(r.active_sessions),
  }));
}
