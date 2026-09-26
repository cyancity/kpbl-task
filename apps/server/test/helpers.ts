import pg from "pg";
import { FastifyInstance } from "fastify";
import { buildMockGateway } from "../../mock-gateway/src/index.js";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import type { AppConfig } from "../src/config.js";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://devin@localhost:5432/gmp_test";

const ADMIN_HASH = "$2a$10$IeTWmbnQs8ho6C.qld/SP./cZvuq8n4RUX06VurV2NaKFQNXaQfDu";
const VIEWER_HASH = "$2a$10$bdm0gRi.le5.oimyasSR3utb.VSObwIu4RVjWaAofrjLXCP.Aecpa";

export async function migrateTestDb(): Promise<void> {
  const pool = createPool(TEST_DB_URL);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE users, auth_sessions, refresh_tokens, accounts, groups, group_members,
      messages, gateway_events, gateway_cursor, dead_events, ws_events, jobs,
      sequences, sequence_runs, sequence_run_steps, agent_runs, agent_steps,
      agent_pending_messages, agent_idempotency RESTART IDENTITY CASCADE
  `);
  await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES
      ('admin', $1, 'admin'), ('viewer', $2, 'viewer') ON CONFLICT DO NOTHING`,
    [ADMIN_HASH, VIEWER_HASH],
  );
  await pool.query(
    `INSERT INTO accounts (id, status) VALUES
      ('acc-1','idle'),('acc-2','idle'),('acc-3','idle'),
      ('acc-4','idle'),('acc-5','idle'),('acc-6','idle') ON CONFLICT DO NOTHING`,
  );
}

export interface TestEnv {
  app: FastifyInstance;
  gatewayApp: FastifyInstance;
  gatewayUrl: string;
  pool: pg.Pool;
}

export async function startTestEnv(): Promise<TestEnv> {
  const gatewayApp = buildMockGateway({ seed: 42 });
  await gatewayApp.listen({ port: 0, host: "127.0.0.1" });
  const addr = gatewayApp.server.address();
  const gatewayUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const config: AppConfig = {
    port: 0,
    databaseUrl: TEST_DB_URL,
    gatewayUrl,
    agentUrl: "http://localhost:4100",
    jwtSecret: "test-secret",
  };
  const app = await buildApp(config);
  const pool = createPool(TEST_DB_URL);
  return { app, gatewayApp, gatewayUrl, pool };
}

export async function stopTestEnv(env: TestEnv): Promise<void> {
  await env.app.close();
  await env.gatewayApp.close();
  await env.pool.end();
}

export async function adminReset(env: TestEnv, path: string, body?: object) {
  return env.gatewayApp.inject({
    method: "POST",
    url: path,
    payload: body ?? {},
  });
}

export async function login(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<{ accessToken: string; cookies: string[] }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  const body = res.json() as { accessToken: string };
  const cookies = res.cookies.map((c) => `${c.name}=${c.value}`);
  return { accessToken: body.accessToken, cookies };
}

export function auth(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` };
}
