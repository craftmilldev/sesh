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
    await tx.query(`INSERT INTO sesh.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgId, user!.id]);
    return { ok: true as const, user: user!, created: true };
  });
}

/** Every org the user belongs to, oldest first, with their role in it. */
export async function userOrgs(db: Db, userId: string): Promise<Membership[]> {
  return db.query<Membership>(
    `SELECT o.id, o.name, m.role FROM sesh.org_members m JOIN sesh.orgs o ON o.id = m.org_id
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
    await tx.query(`INSERT INTO sesh.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [org!.id, userId]);
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

/** Makes a token for the user in an org they belong to. Returns the secret once; only its hash is stored. */
export async function createIngestToken(
  db: Db,
  userId: string,
  orgId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const token = newIngestToken();
  const id = uuidv7();
  await db.query(`INSERT INTO sesh.ingest_tokens (id, org_id, user_id, name, token_hash) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    orgId,
    userId,
    name,
    sha256(token),
  ]);
  return { id, token };
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

/** Who a bearer token speaks for. Revoked tokens, and tokens of users no longer in the org, match nothing. */
export async function findIngestToken(db: Db, token: string): Promise<{ orgId: string; userId: string } | undefined> {
  const [row] = await db.query<{ org_id: string; user_id: string }>(
    `SELECT t.org_id, t.user_id FROM sesh.ingest_tokens t
     JOIN sesh.org_members m ON m.org_id = t.org_id AND m.user_id = t.user_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
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
}

/** One page of the org's sessions, newest first, with the figures summed from their events and prompts. */
export async function listSessions(
  db: Db,
  orgId: string,
  page: number,
): Promise<{ sessions: SessionRow[]; total: number }> {
  const rows = await db.query<Record<keyof SessionRow, string | Date>>(
    `SELECT s.id, u.name AS user_name, s.started_at,
            COALESCE(e.input_tokens, 0) AS input_tokens, COALESCE(e.output_tokens, 0) AS output_tokens,
            COALESCE(e.cache_read_tokens, 0) AS cache_read_tokens, COALESCE(e.cache_write_tokens, 0) AS cache_write_tokens,
            COALESCE(e.tool_calls, 0) AS tool_calls,
            (SELECT count(*) FROM sesh.prompts p WHERE p.session_id = s.id) AS prompts
     FROM sesh.sessions s
     JOIN sesh.users u ON u.id = s.user_id
     LEFT JOIN LATERAL (
       SELECT sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
              sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
              count(*) FILTER (WHERE kind = 'tool_call') AS tool_calls
       FROM sesh.events WHERE session_id = s.id
     ) e ON true
     WHERE s.org_id = $1
     ORDER BY s.started_at DESC, s.id DESC
     LIMIT $2 OFFSET $3`,
    [orgId, SESSIONS_PAGE_SIZE, (page - 1) * SESSIONS_PAGE_SIZE],
  );
  const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM sesh.sessions WHERE org_id = $1`, [orgId]);
  return {
    total: Number(count!.n),
    sessions: rows.map((r) => ({
      id: r.id as string,
      user_name: r.user_name as string,
      started_at: new Date(r.started_at),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cache_read_tokens: Number(r.cache_read_tokens),
      cache_write_tokens: Number(r.cache_write_tokens),
      prompts: Number(r.prompts),
      tool_calls: Number(r.tool_calls),
    })),
  };
}
