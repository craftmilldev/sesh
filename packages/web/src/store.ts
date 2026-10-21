import type { Db } from "./db/index.js";
import { newLoginCode, normalizeLoginCode, safeEqual, sha256, uuidv7 } from "./ids.js";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Org {
  id: string;
  name: string;
}

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
