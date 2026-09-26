import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";
import { FastifyInstance } from "fastify";
import { buildMockGateway } from "../../../mock-gateway/src/index.js";
import { buildMockAgent } from "../../../mock-agent/src/index.js";
import { createPool } from "../../src/db/pool.js";
import { runMigrations } from "../../src/db/migrate.js";
import { truncateAll } from "../helpers.js";

export const ADV_DB_URL =
  process.env.ADV_DATABASE_URL ?? "postgres://devin@localhost:5432/gmp_adv";

export async function migrateAdvDb(): Promise<void> {
  const pool = createPool(ADV_DB_URL);
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

export async function resetAdvDb(pool: pg.Pool): Promise<void> {
  await truncateAll(pool);
}

export interface AdvEnv {
  gatewayApp: FastifyInstance;
  agentApp: FastifyInstance;
  gatewayUrl: string;
  agentUrl: string;
  pool: pg.Pool;
}

export async function startMocks(opts?: {
  gatewayConfig?: Record<string, unknown>;
}): Promise<AdvEnv> {
  const gatewayApp = buildMockGateway({ seed: 7 });
  await gatewayApp.listen({ port: 0, host: "127.0.0.1" });
  const gaddr = gatewayApp.server.address();
  const gatewayUrl = `http://127.0.0.1:${typeof gaddr === "object" && gaddr ? gaddr.port : 0}`;
  await gatewayApp.inject({
    method: "POST",
    url: "/__admin/config",
    payload: {
      sendDelayMinMs: 10,
      sendDelayMaxMs: 30,
      joinDelayMinMs: 10,
      joinDelayMaxMs: 50,
      kickDelayMinMs: 10,
      kickDelayMaxMs: 50,
      ...(opts?.gatewayConfig ?? {}),
    },
  });
  const agentApp = buildMockAgent();
  await agentApp.listen({ port: 0, host: "127.0.0.1" });
  const aaddr = agentApp.server.address();
  const agentUrl = `http://127.0.0.1:${typeof aaddr === "object" && aaddr ? aaddr.port : 0}`;
  const pool = createPool(ADV_DB_URL);
  return { gatewayApp, agentApp, gatewayUrl, agentUrl, pool };
}

export interface ServerHandle {
  proc: ChildProcess;
  port: number;
  base: string;
  stderr: () => string;
}

let nextPort = 20_000 + (process.pid % 1000);

export async function spawnServer(
  env: AdvEnv,
  extraEnv: Record<string, string> = {},
): Promise<ServerHandle> {
  const port = nextPort++;
  const stderrChunks: string[] = [];
  // detached: spawn the server directly (no npx wrapper) inside its own
  // process group so kill9 can take the whole tree down — killing a wrapper
  // alone orphans the real server, which keeps workers running against the
  // shared adversarial DB.
  const proc = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: ADV_DB_URL,
      GATEWAY_URL: env.gatewayUrl,
      AGENT_URL: env.agentUrl,
      JWT_SECRET: "adv-secret",
      JOIN_TIMEOUT_MS: "8000",
      AGENT_TURN_TIMEOUT_MS: "4000",
      AUDIT_TIMEOUT_MS: "1000",
      // Crash-recovery tests wait out the lease; keep it well under their
      // waitFor budgets while still covering a single step's worst case.
      AGENT_LEASE_MS: "15000",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr?.on("data", (c: Buffer) => {
    stderrChunks.push(c.toString());
    if (stderrChunks.length > 200) stderrChunks.shift();
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(
        `server exited ${proc.exitCode}:\n${stderrChunks.join("").slice(-4000)}`,
      );
    }
    try {
      await fetch(`${base}/api/accounts`);
      break; // any HTTP response (401) means the server is listening
    } catch {
      if (Date.now() > deadline) {
        proc.kill("SIGKILL");
        throw new Error(
          `server did not start:\n${stderrChunks.join("").slice(-4000)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // give workers a beat to start their loops
  await new Promise((r) => setTimeout(r, 400));
  return {
    proc,
    port,
    base,
    stderr: () => stderrChunks.join(""),
  };
}

export function kill9(h: ServerHandle): void {
  try {
    if (typeof h.proc.pid === "number") process.kill(-h.proc.pid, "SIGKILL");
    else h.proc.kill("SIGKILL");
  } catch {
    try {
      h.proc.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

export async function waitFor(
  fn: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
  intervalMs = 60,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out${lastErr ? `: ${String(lastErr)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function api(
  h: ServerHandle,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

export async function login(
  h: ServerHandle,
  username = "admin",
  password = "admin",
): Promise<string> {
  const { body } = await api(h, "POST", "/api/auth/login", undefined, {
    username,
    password,
  });
  return (body as { accessToken: string }).accessToken;
}

export async function gwAdmin(
  env: AdvEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = (await env.gatewayApp.inject({
    method: method as "POST",
    url: path,
    payload: body as never,
  })) as unknown as { statusCode: number; json: () => unknown };
  let json: unknown;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, body: json };
}

export async function agentAdmin(
  env: AdvEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = (await env.agentApp.inject({
    method: method as "POST",
    url: path,
    payload: body as never,
  })) as unknown as { json: () => unknown };
  try {
    return res.json();
  } catch {
    return null;
  }
}

export async function gwState(env: AdvEnv): Promise<{
  accounts: { id: string; sendCalls: number; connected: boolean; rateLimitedUntil: number }[];
  groups: { id: string; members: string[] }[];
  messages: { groupId: string; messages: { msgId: string; clientMsgId: string | null }[] }[];
  events: unknown[];
  joinAttempts: unknown[];
}> {
  const res = await env.gatewayApp.inject({ method: "GET", url: "/__admin/state" });
  return res.json() as never;
}

/** Seeds a group entirely through the public APIs + mock admin (no job). */
export async function seedGroupAdv(
  h: ServerHandle,
  env: AdvEnv,
  token: string,
  memberAccountIds: string[] = ["acc-2"],
): Promise<{ groupId: string; gatewayGroupId: string }> {
  for (const id of ["acc-1", ...memberAccountIds]) {
    const res = await api(h, "POST", `/api/accounts/${id}/connect`, token);
    if (res.status !== 200) {
      // account may already be online from a previous run in the same test
      if ((res.body as { error?: { code?: string } }).error?.code !== "ILLEGAL_TRANSITION") {
        throw new Error(`connect ${id}: ${JSON.stringify(res.body)}`);
      }
    }
  }
  const g = await gwAdmin(env, "POST", "/groups", { creatorAccountId: "acc-1" });
  const gatewayGroupId = (g.body as { groupId: string }).groupId;
  const groupId = crypto.randomUUID();
  await env.pool.query(
    "INSERT INTO groups (id, gateway_group_id, status, creator_account_id) VALUES ($1,$2,'active','acc-1')",
    [groupId, gatewayGroupId],
  );
  await env.pool.query(
    "INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-1','pu-acc-1','creator')",
    [groupId],
  );
  for (const id of memberAccountIds) {
    await env.pool.query(
      "INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1,$2,$3,'member')",
      [groupId, id, `pu-${id}`],
    );
    await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-join`, {
      platformUserId: `pu-${id}`,
    });
  }
  return { groupId, gatewayGroupId };
}
