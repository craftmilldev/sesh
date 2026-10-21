import { createHmac } from "node:crypto";
import { safeEqual } from "./ids.js";

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * What a bearer token carries. `exp` is optional so a token can be short-lived (sessions) or not (robots).
 * `scope` is reserved for later and not read anywhere yet.
 */
export interface TokenClaims {
  sub: string;
  typ: "session";
  iat: number;
  exp?: number;
  scope?: string[];
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (data: string, secret: string) => createHmac("sha256", secret).update(data).digest("base64url");
const HEADER = b64({ alg: "HS256", typ: "JWT" });

/** Signs an HS256 JWT. A session token lives 30 days. */
export function signSessionToken(userId: string, secret: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const claims: TokenClaims = { sub: userId, typ: "session", iat, exp: iat + SESSION_TTL_SECONDS };
  const data = `${HEADER}.${b64(claims)}`;
  return { token: `${data}.${sign(data, secret)}`, expiresAt: new Date(claims.exp! * 1000) };
}

/** Returns the claims if the signature is valid and the token hasn't expired; undefined otherwise. */
export function verifyToken(token: string, secret: string, now = Date.now()): TokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== HEADER) return undefined;
  if (!safeEqual(parts[2]!, sign(`${parts[0]}.${parts[1]}`, secret))) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as TokenClaims;
    if (typeof claims.sub !== "string" || claims.typ !== "session") return undefined;
    if (claims.exp !== undefined && !(claims.exp * 1000 > now)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
