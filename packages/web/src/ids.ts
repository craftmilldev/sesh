import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** UUIDv7: time-ordered, so `ORDER BY id` is creation order. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Eight characters (40 bits) of Crockford base32, which has no I/L/O/U look-alikes, for a person to type.
 * 32 divides 256, so taking each random byte mod 32 is unbiased.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LOGIN_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const newLoginCode = () => Array.from(randomBytes(8), (b) => CROCKFORD[b % 32]).join("");
/** Accepts what people type: any case, spaces or dashes, and Crockford's O→0, I/L→1. */
export const normalizeLoginCode = (s: string) =>
  s.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** An unguessable invite token for a link. */
export const newInviteToken = () => randomBytes(24).toString("base64url");

/** An ingest token: the prefix makes a leaked one easy to spot and scan for. */
export const newIngestToken = () => `sesh_${randomBytes(24).toString("base64url")}`;
