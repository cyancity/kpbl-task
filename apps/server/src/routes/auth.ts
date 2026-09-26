import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { AppError } from "../errors.js";
import {
  createSession,
  issueRefreshToken,
  revokeSession,
  sha256,
  signAccessToken,
} from "../auth/session.js";
import type { AppContext } from "../context.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const REFRESH_COOKIE = "refresh_token";
const cookieOpts = {
  path: "/api/auth",
  httpOnly: true,
  sameSite: "lax" as const,
};

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/auth/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await ctx.pool.query<{
      id: number;
      username: string;
      password_hash: string;
      role: string;
    }>("SELECT id, username, password_hash, role FROM users WHERE username = $1", [body.username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw new AppError(401, "UNAUTHORIZED", "invalid credentials");
    }
    const { sessionId, refreshToken } = await createSession(ctx.pool, user.id);
    const accessToken = signAccessToken(ctx.config.jwtSecret, {
      sub: user.username,
      role: user.role,
      sid: sessionId,
    });
    reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts);
    return { accessToken };
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw new AppError(401, "UNAUTHORIZED", "missing refresh token");
    const { rows } = await ctx.pool.query<{
      id: string;
      session_id: string;
      used_at: Date | null;
      expires_at: Date;
      revoked_at: Date | null;
      username: string;
      role: string;
    }>(
      `SELECT rt.id, rt.session_id, rt.used_at, rt.expires_at,
              s.revoked_at, u.username, u.role
         FROM refresh_tokens rt
         JOIN auth_sessions s ON s.id = rt.session_id
         JOIN users u ON u.id = s.user_id
        WHERE rt.token_hash = $1`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) throw new AppError(401, "UNAUTHORIZED", "invalid refresh token");

    if (row.used_at !== null) {
      // Refresh token reuse detected: revoke the whole session.
      await revokeSession(ctx.pool, row.session_id);
      ctx.sessionCache.markRevoked(row.session_id);
      throw new AppError(401, "UNAUTHORIZED", "refresh token reuse detected");
    }
    if (row.revoked_at !== null || row.expires_at.getTime() < Date.now()) {
      throw new AppError(401, "UNAUTHORIZED", "session expired");
    }

    // Atomic rotation: the WHERE clause makes a concurrent refresh of the same
    // token a no-op, so the loser is detected as reuse (and revokes the
    // session) instead of silently receiving a second valid access token.
    const { rowCount } = await ctx.pool.query(
      "UPDATE refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL",
      [row.id],
    );
    if (!rowCount) {
      await revokeSession(ctx.pool, row.session_id);
      ctx.sessionCache.markRevoked(row.session_id);
      throw new AppError(401, "UNAUTHORIZED", "refresh token reuse detected");
    }
    const newRefresh = await issueRefreshToken(ctx.pool, row.session_id);
    const accessToken = signAccessToken(ctx.config.jwtSecret, {
      sub: row.username,
      role: row.role,
      sid: row.session_id,
    });
    reply.setCookie(REFRESH_COOKIE, newRefresh, cookieOpts);
    return { accessToken };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      const { rows } = await ctx.pool.query<{ session_id: string }>(
        "SELECT session_id FROM refresh_tokens WHERE token_hash = $1 ORDER BY created_at DESC LIMIT 1",
        [sha256(token)],
      );
      if (rows[0]) {
        await revokeSession(ctx.pool, rows[0].session_id);
        ctx.sessionCache.markRevoked(rows[0].session_id);
      }
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req) => {
    const claims = await ctx.authenticate(req);
    return { username: claims.sub, role: claims.role };
  });
}
