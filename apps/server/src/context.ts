import { FastifyRequest } from "fastify";
import pg from "pg";
import type { AppConfig } from "./config.js";
import type { GatewayClient } from "./gateway/client.js";
import type { AccessClaims, SessionRevocationCache } from "./auth/session.js";

export interface AppContext {
  config: AppConfig;
  pool: pg.Pool;
  gateway: GatewayClient;
  sessionCache: SessionRevocationCache;
  authenticate: (req: FastifyRequest) => Promise<AccessClaims>;
}
