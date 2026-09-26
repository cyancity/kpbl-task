import { FastifyRequest } from "fastify";
import pg from "pg";
import type { AppConfig } from "./config.js";
import type { GatewayClient } from "./gateway/client.js";
import type { AccessClaims, SessionRevocationCache } from "./auth/session.js";

export interface InboundMessageRow {
  id: string;
  group_id: string;
  msg_id: string | null;
  sender_platform_user_id: string | null;
  text: string | null;
  sent_at: Date;
}

export interface AppHooks {
  /** P4: called inside the event tx for each non-own inbound message. */
  onInboundMessage: (client: pg.PoolClient, row: InboundMessageRow) => Promise<void>;
  /** P3: called inside the event tx on member_joined. */
  onMemberJoined: (client: pg.PoolClient, groupId: string, platformUserId: string) => Promise<void>;
}

export interface FaultInjection {
  /** test-only: makes the next gateway-event handler throw. */
  failNextEventHandler: boolean;
}

export interface AppContext {
  config: AppConfig;
  pool: pg.Pool;
  gateway: GatewayClient;
  sessionCache: SessionRevocationCache;
  hooks: AppHooks;
  faults: FaultInjection;
  log: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  authenticate: (req: FastifyRequest) => Promise<AccessClaims>;
  verifyAccess: (accessToken: string) => Promise<AccessClaims>;
}
