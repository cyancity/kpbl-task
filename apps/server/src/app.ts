import crypto from "node:crypto";
import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { AppError } from "./errors.js";
import { createPool } from "./db/pool.js";
import { currentSchemaVersion } from "./db/migrate.js";
import { GatewayClient } from "./gateway/client.js";
import { SessionRevocationCache, verifyAccessToken, type AccessClaims } from "./auth/session.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerAgentRunRoutes } from "./routes/agentRuns.js";
import { registerSequenceRoutes } from "./routes/sequences.js";
import { onInboundMessageTrigger } from "./domain/agent/trigger.js";
import { registerWsRoute } from "./ws/server.js";
import type { AppConfig } from "./config.js";
import type { AppContext } from "./context.js";

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/health"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(cookie);
  await app.register(websocket);

  const pool = createPool(config.databaseUrl);
  const gateway = new GatewayClient(config.gatewayUrl);
  const sessionCache = new SessionRevocationCache(pool);
  const log = app.log;

  const verifyAccess = async (accessToken: string): Promise<AccessClaims> => {
    const claims = verifyAccessToken(config.jwtSecret, accessToken);
    if (!claims) throw new AppError(401, "UNAUTHORIZED", "invalid access token");
    if (await sessionCache.isRevoked(claims.sid)) {
      throw new AppError(401, "UNAUTHORIZED", "session revoked");
    }
    return claims;
  };

  const authenticate = async (req: FastifyRequest): Promise<AccessClaims> => {
    const header = req.headers.authorization;
    // RFC 7235: the auth scheme is case-insensitive.
    const token = header && /^bearer /i.test(header) ? header.slice(7) : null;
    if (!token) throw new AppError(401, "UNAUTHORIZED", "missing access token");
    return verifyAccess(token);
  };

  const ctx: AppContext = {
    config,
    pool,
    gateway,
    sessionCache,
    hooks: {
      onInboundMessage: onInboundMessageTrigger,
      onMemberJoined: async () => {},
    },
    faults: { failNextEventHandler: false, failAfterExecuting: false },
    log,
    authenticate,
    verifyAccess,
  };
  app.decorate("ctx", ctx);

  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") || PUBLIC_PATHS.has(path)) return;
    // Cookie-based session endpoints authenticate via the refresh cookie, not JWT.
    if (path.startsWith("/api/auth/") && path !== "/api/auth/me") return;
    const claims = await authenticate(req);
    req.requestContext = claims;
    if (WRITE_METHODS.has(req.method) && claims.role !== "admin") {
      throw new AppError(403, "FORBIDDEN", "viewer role cannot perform write operations");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, requestId, ...err.extra } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          requestId,
        },
      });
    }
    req.log.error(err);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "internal server error", requestId } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: `${req.method} ${req.url} not found`,
        requestId: req.id,
      },
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    schemaVersion: await currentSchemaVersion(pool),
  }));

  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerAgentRunRoutes(app, ctx);
  registerSequenceRoutes(app, ctx);
  registerWsRoute(app, ctx);

  app.addHook("onClose", async () => {
    await pool.end();
  });

  return app;
}
