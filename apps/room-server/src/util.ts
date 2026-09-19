import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export const uuid = () => randomUUID();
export const sha256 = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("hex");
export const nowIso = (ms: number) => new Date(ms).toISOString();

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(Buffer.from(secret, "hex"), salt, 32, SCRYPT_OPTS);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let candidate: Buffer;
  try {
    candidate = scryptSync(Buffer.from(secret, "hex"), Buffer.from(saltHex, "hex"), 32, SCRYPT_OPTS);
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function generateRoomCode(len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

export function normalizeRoomCode(input: string): string {
  return input.replace(/-/g, "").toUpperCase();
}

export function isValidRoomCode(code: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code);
}
