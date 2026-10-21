import type { Db } from "./db/index.js";
import { newInviteToken, newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

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

/** Makes a one-use invite link token for an org. Only an owner can; returns undefined for anyone else. */
export async function createInvite(db: Db, userId: string, orgId: string): Promise<string | undefined> {
  const token = newInviteToken();
  const made = await db.query(
    `INSERT INTO sesh.org_invites (id, org_id, token_hash, created_by, expires_at)
     SELECT $1, org_id, $2, user_id, now() + $5::int * interval '1 day'
     FROM sesh.org_members WHERE org_id = $3 AND user_id = $4 AND role = 'owner'
     RETURNING id`,
    [uuidv7(), sha256(token), orgId, userId, INVITE_TTL_DAYS],
  );
  return made.length ? token : undefined;
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
