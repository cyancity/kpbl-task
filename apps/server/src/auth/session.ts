import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  sub: string;
  role: string;
  sid: string;
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function signAccessToken(jwtSecret: string, claims: AccessClaims): string {
  return jwt.sign(claims, jwtSecret, { expiresIn: ACCESS_TTL_SECONDS });
}

export function verifyAccessToken(jwtSecret: string, token: string): AccessClaims | null {
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (typeof decoded === "object" && decoded && "sub" in decoded && "sid" in decoded) {
      return decoded as AccessClaims;
    }
    return null;
  } catch {
    return null;
  }
}

export async function createSession(
  pool: pg.Pool,
  userId: number,
): Promise<{ sessionId: string; refreshToken: string }> {
  const sessionId = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  await pool.query("INSERT INTO auth_sessions (id, user_id, family_id) VALUES ($1, $2, $3)", [
    sessionId,
    userId,
    familyId,
  ]);
  const refreshToken = await issueRefreshToken(pool, sessionId);
  return { sessionId, refreshToken };
}

export async function issueRefreshToken(pool: pg.Pool, sessionId: string): Promise<string> {
  const token = crypto.randomBytes(48).toString("base64url");
  await pool.query(
    "INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [crypto.randomUUID(), sessionId, sha256(token), new Date(Date.now() + REFRESH_TTL_MS)],
  );
  return token;
}

export async function revokeSession(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    "UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
}

/** Positive-only cache: a revoked marker never expires, while active sessions
 *  are re-checked against the DB so a logout on another instance takes effect
 *  immediately (a cached "active" verdict would linger otherwise). */
export class SessionRevocationCache {
  private cache = new Map<string, { at: number }>();
  private ttlMs = 5000;

  constructor(private readonly pool: pg.Pool) {}

  markRevoked(sessionId: string): void {
    this.cache.set(sessionId, { at: Date.now() });
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const hit = this.cache.get(sessionId);
    if (hit && Date.now() - hit.at < this.ttlMs) return true;
    const { rows } = await this.pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM auth_sessions WHERE id = $1",
      [sessionId],
    );
    const revoked = !rows[0] || rows[0].revoked_at !== null;
    if (revoked) {
      this.markRevoked(sessionId);
    } else {
      this.cache.delete(sessionId);
    }
    return revoked;
  }
}
