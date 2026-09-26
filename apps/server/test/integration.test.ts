import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  migrateTestDb,
  truncateAll,
  startTestEnv,
  stopTestEnv,
  login,
  auth,
  type TestEnv,
} from "./helpers.js";
import { checkSchemaVersion, runMigrations } from "../src/db/migrate.js";
import { enterTerminal } from "../src/domain/accounts/service.js";
import { GatewayClient } from "../src/gateway/client.js";

let env: TestEnv;

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  env = await startTestEnv();
  await truncateAll(env.pool);
});

afterEach(async () => {
  await stopTestEnv(env);
});

describe("auth", () => {
  it("login returns accessToken and refresh cookie; /me works", async () => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin" },
    });
    expect(res.statusCode).toBe(200);
    const { accessToken } = res.json() as { accessToken: string };
    expect(accessToken).toBeTruthy();
    const cookie = res.cookies.find((c) => c.name === "refresh_token");
    expect(cookie?.httpOnly).toBe(true);

    const me = await env.app.inject({ url: "/api/auth/me", headers: auth(accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: "admin", role: "admin" });
  });

  it("viewer gets 403 FORBIDDEN on write routes", async () => {
    const { accessToken } = await login(env.app, "viewer", "viewer");
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-1/transition",
      headers: auth(accessToken),
      payload: { to: "disconnected", expectedFrom: "idle" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(res.json().error.requestId).toBeTruthy();
  });

  it("bad token gets 401 UNAUTHORIZED", async () => {
    const res = await env.app.inject({
      url: "/api/accounts",
      headers: { authorization: "Bearer garbage" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("refresh rotates the refresh token", async () => {
    const { cookies } = await login(env.app, "admin", "admin");
    const res = await env.app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: cookies.join("; ") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    const newCookie = res.cookies.find((c) => c.name === "refresh_token");
    expect(newCookie).toBeTruthy();
    expect(newCookie!.value).not.toBe(cookies[0]!.split("=")[1]);
  });

  it("refresh token reuse revokes session and rejects access token", async () => {
    const { accessToken, cookies } = await login(env.app, "admin", "admin");
    const oldCookie = cookies.join("; ");
    const first = await env.app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: oldCookie },
    });
    expect(first.statusCode).toBe(200);
    const newAccess = first.json().accessToken as string;

    // Reuse the OLD refresh token → session revoked.
    const reuse = await env.app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: oldCookie },
    });
    expect(reuse.statusCode).toBe(401);

    for (const token of [accessToken, newAccess]) {
      const res = await env.app.inject({ url: "/api/auth/me", headers: auth(token) });
      expect(res.statusCode).toBe(401);
    }
  });

  it("logout revokes session so old access token is rejected", async () => {
    const { accessToken, cookies } = await login(env.app, "admin", "admin");
    const res = await env.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookies.join("; ") },
    });
    expect(res.statusCode).toBe(204);
    const me = await env.app.inject({ url: "/api/auth/me", headers: auth(accessToken) });
    expect(me.statusCode).toBe(401);
  });
});

describe("health & schema", () => {
  it("health returns schemaVersion", async () => {
    const res = await env.app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, schemaVersion: 3 });
  });

  it("migration re-run is a no-op", async () => {
    const applied = await runMigrations(env.pool);
    expect(applied).toEqual([]);
  });

  it("checkSchemaVersion reports behind / current", async () => {
    expect(await checkSchemaVersion(env.pool)).toBeNull();
    await env.pool.query("DELETE FROM schema_migrations WHERE version = 3");
    const behind = await checkSchemaVersion(env.pool);
    expect(behind).toEqual({ current: 2, expected: 3 });
    // restore bookkeeping without re-running the DDL
    await env.pool.query(
      "INSERT INTO schema_migrations (version, name) VALUES (3, '003_outbox.sql')",
    );
  });
});

describe("accounts", () => {
  it("GET /api/accounts lists seeded accounts", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    const res = await env.app.inject({ url: "/api/accounts", headers: auth(accessToken) });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; status: string }>;
    expect(list).toHaveLength(6);
    expect(list[0]).toMatchObject({ id: "acc-1", status: "idle", platformUserId: null });
  });

  it("transition: 404 for unknown account", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/nope/transition",
      headers: auth(accessToken),
      payload: { to: "disconnected", expectedFrom: "idle" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("transition: 400 VALIDATION_ERROR on bad body", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-1/transition",
      headers: auth(accessToken),
      payload: { to: "bogus" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("transition: ILLEGAL_TRANSITION beats CAS_CONFLICT", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    // acc-1 is idle; rate_limited -> idle is illegal AND expectedFrom mismatches
    // reality: the transition table must be checked before the CAS check.
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-1/transition",
      headers: auth(accessToken),
      payload: { to: "idle", expectedFrom: "rate_limited" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("transition: CAS_CONFLICT when status differs", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-1/transition",
      headers: auth(accessToken),
      payload: { to: "online", expectedFrom: "disconnected" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CAS_CONFLICT");
  });

  it("concurrent transitions: exactly one wins", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    const [a, b] = await Promise.all([
      env.app.inject({
        method: "POST",
        url: "/api/accounts/acc-1/transition",
        headers: auth(accessToken),
        payload: { to: "online", expectedFrom: "idle" },
      }),
      env.app.inject({
        method: "POST",
        url: "/api/accounts/acc-1/transition",
        headers: auth(accessToken),
        payload: { to: "online", expectedFrom: "idle" },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe("CAS_CONFLICT");
  });

  it("terminal cascade removes members, cancels queued messages, emits ws events", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    // seed a group + member + queued message
    const groupId = "11111111-1111-1111-1111-111111111111";
    await env.pool.query(
      "INSERT INTO groups (id, status, creator_account_id) VALUES ($1, 'active', 'acc-1')",
      [groupId],
    );
    await env.pool.query(
      "INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-1','pu-acc-1','creator')",
      [groupId],
    );
    const clientMsgId = "22222222-2222-2222-2222-222222222222";
    await env.pool.query(
      `INSERT INTO messages (group_id, client_msg_id, sender_account_id, sender_platform_user_id, is_own, text, sent_at, delivery_status)
       VALUES ($1,$2,'acc-1','pu-acc-1',true,'hi',now(),'queued')`,
      [groupId, clientMsgId],
    );

    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-1/transition",
      headers: auth(accessToken),
      payload: { to: "suspended", expectedFrom: "idle" },
    });
    expect(res.statusCode).toBe(200);

    const members = await env.pool.query("SELECT * FROM group_members WHERE account_id='acc-1'");
    expect(members.rows).toHaveLength(0);
    const msg = await env.pool.query(
      "SELECT delivery_status, fail_code FROM messages WHERE client_msg_id=$1",
      [clientMsgId],
    );
    expect(msg.rows[0]).toMatchObject({
      delivery_status: "cancelled",
      fail_code: "ACCOUNT_TERMINAL",
    });
    const ws = await env.pool.query("SELECT type FROM ws_events ORDER BY seq");
    expect(ws.rows.map((r) => r.type)).toEqual(["account_status_changed", "account_terminal"]);
  });

  it("re-marking suspended via API is ILLEGAL but enterTerminal is a no-op", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-2/transition",
      headers: auth(accessToken),
      payload: { to: "suspended", expectedFrom: "idle" },
    });
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-2/transition",
      headers: auth(accessToken),
      payload: { to: "suspended", expectedFrom: "suspended" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ILLEGAL_TRANSITION");

    const gateway = new GatewayClient(env.gatewayUrl);
    await expect(enterTerminal(env.pool, gateway, "acc-2", "suspended")).resolves.toBeUndefined();
    await expect(
      enterTerminal(env.pool, gateway, "acc-2", "session_expired"),
    ).resolves.toBeUndefined();
    const { rows } = await env.pool.query("SELECT status FROM accounts WHERE id='acc-2'");
    expect(rows[0]!.status).toBe("suspended");
  });

  it("connect: idle -> online with platformUserId", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-3/connect",
      headers: auth(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "online", platformUserId: "pu-acc-3" });
    const { rows } = await env.pool.query(
      "SELECT status, platform_user_id FROM accounts WHERE id='acc-3'",
    );
    expect(rows[0]).toMatchObject({ status: "online", platform_user_id: "pu-acc-3" });
  });

  it("connect: gateway suspended -> terminal + 409 ACCOUNT_UNAVAILABLE", async () => {
    const { accessToken } = await login(env.app, "admin", "admin");
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-4/status",
      payload: { status: "suspended" },
    });
    const res = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-4/connect",
      headers: auth(accessToken),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ACCOUNT_UNAVAILABLE");
    const { rows } = await env.pool.query("SELECT status FROM accounts WHERE id='acc-4'");
    expect(rows[0]!.status).toBe("suspended");
  });
});
