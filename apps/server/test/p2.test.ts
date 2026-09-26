import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  migrateTestDb,
  truncateAll,
  startTestEnv,
  stopTestEnv,
  login,
  auth,
  waitFor,
  seedGroup,
  type TestEnv,
} from "./helpers.js";
import { startWorkers, type WorkersHandle } from "../src/workers/index.js";

let env: TestEnv;
let workers: WorkersHandle | null = null;
let token: string;

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  env = await startTestEnv();
  await truncateAll(env.pool);
  ({ accessToken: token } = await login(env.app, "admin", "admin"));
});

afterEach(async () => {
  await workers?.stop();
  workers = null;
  await stopTestEnv(env);
});

async function messageRow(clientMsgId: string) {
  const { rows } = await env.pool.query("SELECT * FROM messages WHERE client_msg_id = $1", [
    clientMsgId,
  ]);
  return rows[0];
}

async function mockState() {
  const res = await env.gatewayApp.inject({ url: "/__admin/state" });
  return res.json() as {
    accounts: Array<{ id: string; sendCalls: number }>;
    groups: Array<{ id: string; members: Array<{ platformUserId: string }> }>;
    messages: Array<{ groupId: string; messages: Array<{ clientMsgId: string }> }>;
  };
}

describe("outbound delivery", () => {
  it("S1: send -> accepted -> sent with msgId; reflux creates no extra row", async () => {
    // Slow the mock so the accepted window is observable before message_sent lands.
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/config",
      payload: { sendDelayMinMs: 400, sendDelayMaxMs: 500 },
    });
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token);
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "hello" },
    });
    expect(res.statusCode).toBe(202);
    const { clientMsgId } = res.json() as { clientMsgId: string };

    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "accepted");
    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "sent");
    const row = await messageRow(clientMsgId);
    expect(row.msg_id).toBeTruthy();

    // The reflux `message` event must not create a second row.
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
        [groupId],
      );
      return rows[0]!.c === 1;
    });
    const timeline = await env.app.inject({
      url: `/api/groups/${groupId}/messages`,
      headers: auth(token),
    });
    const items = timeline.json().items as Array<{ isOwn: boolean; msgId: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.isOwn).toBe(true);
  });

  it("S4: 429 -> rate_limited, queue held during window, resent in order after expiry", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-1/inject",
      payload: { code: "RATE_LIMITED", retryAfterSeconds: 1 },
    });
    const send = (text: string) =>
      env.app.inject({
        method: "POST",
        url: `/api/groups/${groupId}/send`,
        headers: auth(token),
        payload: { accountId: "acc-1", text },
      });
    const r1 = await send("m1");
    const r2 = await send("m2");
    const r3 = await send("m3");
    const ids = [r1, r2, r3].map((r) => (r.json() as { clientMsgId: string }).clientMsgId);

    await waitFor(async () => {
      const { rows } = await env.pool.query("SELECT status FROM accounts WHERE id='acc-1'");
      return rows[0]!.status === "rate_limited";
    });
    const callsDuring = (await mockState()).accounts.find((a) => a.id === "acc-1")!.sendCalls;

    // During the window nothing else may be sent to the gateway.
    await new Promise((r) => setTimeout(r, 400));
    expect((await mockState()).accounts.find((a) => a.id === "acc-1")!.sendCalls).toBe(callsDuring);

    // After expiry all three land, in order.
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT count(*)::int AS c FROM messages WHERE delivery_status='sent'",
      );
      return rows[0]!.c === 3;
    }, 10000);
    const state = await mockState();
    const landed = state.messages.find((m) => m.groupId !== undefined)!.messages;
    expect(landed.map((m) => m.clientMsgId)).toEqual(ids);
  });

  it("504 not delivered -> resend once with same clientMsgId -> sent", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-1/inject",
      payload: { code: "NETWORK_TIMEOUT", actuallyDelivered: false },
    });
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "t" },
    });
    const { clientMsgId } = res.json() as { clientMsgId: string };
    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "sent", 12000);
    const row = await messageRow(clientMsgId);
    expect(row.resend_count).toBe(1);
    const state = await mockState();
    const msgs = state.messages.find((m) => m.groupId === gatewayGroupId)!.messages;
    expect(msgs).toHaveLength(1);
  });

  it("504 twice -> failed NETWORK_TIMEOUT after the single allowed resend", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token);
    for (let i = 0; i < 2; i++) {
      await env.gatewayApp.inject({
        method: "POST",
        url: "/__admin/accounts/acc-1/inject",
        payload: { code: "NETWORK_TIMEOUT", actuallyDelivered: false },
      });
    }
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "t" },
    });
    const { clientMsgId } = res.json() as { clientMsgId: string };
    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "failed", 15000);
    const row = await messageRow(clientMsgId);
    expect(row.fail_code).toBe("NETWORK_TIMEOUT");
    expect(row.resend_count).toBe(1);
  });

  it("504 actually delivered -> becomes sent, never resent", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-1/inject",
      payload: { code: "NETWORK_TIMEOUT", actuallyDelivered: true },
    });
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "t" },
    });
    const { clientMsgId } = res.json() as { clientMsgId: string };
    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "sent", 12000);
    const row = await messageRow(clientMsgId);
    expect(row.resend_count).toBe(0);
    const state = await mockState();
    expect(state.messages.find((m) => m.groupId === gatewayGroupId)!.messages).toHaveLength(1);
    expect(state.accounts.find((a) => a.id === "acc-1")!.sendCalls).toBe(1);
  });

  it("by-client-id 503 keeps row unknown; resolved after recovery", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-1/inject",
      payload: { code: "NETWORK_TIMEOUT", actuallyDelivered: false },
    });
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "t" },
    });
    const { clientMsgId } = res.json() as { clientMsgId: string };
    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "unknown");

    // Make the whole gateway unavailable: probes must not conclude.
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/config",
      payload: { unavailable: true },
    });
    await new Promise((r) => setTimeout(r, 2200));
    expect((await messageRow(clientMsgId)).delivery_status).toBe("unknown");

    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/config",
      payload: { unavailable: false },
    });
    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "sent", 10000);
    const state = await mockState();
    expect(state.messages.find((m) => m.groupId === gatewayGroupId)!.messages).toHaveLength(1);
  });

  it("crash recovery: stale sending row becomes unknown and is reconciled", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token);
    const clientMsgId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO messages (group_id, client_msg_id, sender_account_id, sender_platform_user_id,
        is_own, text, sent_at, delivery_status, sending_since)
       VALUES ($1,$2,'acc-1','pu-acc-1',true,'t',now(),'sending', now() - interval '20 seconds')`,
      [groupId, clientMsgId],
    );
    await waitFor(
      async () =>
        ["sent", "failed", "accepted", "queued"].includes(
          (await messageRow(clientMsgId))?.delivery_status,
        ),
      10000,
    );
  });
});

describe("error paths", () => {
  it("ACCOUNT_SUSPENDED on send -> terminal, in-flight cancelled, queued cancelled", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token, []);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-1/inject",
      payload: { code: "SUSPENDED" },
    });
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "t" },
    });
    const { clientMsgId } = res.json() as { clientMsgId: string };
    await env.pool.query(
      `INSERT INTO messages (group_id, client_msg_id, sender_account_id, is_own, text, sent_at, delivery_status)
       VALUES ($1,$2,'acc-1',true,'q',now(),'queued')`,
      [groupId, crypto.randomUUID()],
    );
    await waitFor(async () => {
      const { rows } = await env.pool.query("SELECT status FROM accounts WHERE id='acc-1'");
      return rows[0]!.status === "suspended";
    });
    const row = await messageRow(clientMsgId);
    expect(row.delivery_status).toBe("cancelled");
    expect(row.fail_code).toBe("ACCOUNT_TERMINAL");
    const { rows: queued } = await env.pool.query(
      "SELECT delivery_status, fail_code FROM messages WHERE group_id=$1 AND id<>$2",
      [groupId, row.id],
    );
    expect(queued[0]).toMatchObject({
      delivery_status: "cancelled",
      fail_code: "ACCOUNT_TERMINAL",
    });
  });

  it("GROUP_WRITE_FORBIDDEN -> group unreachable, other queued failed GROUP_UNREACHABLE", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token, []);
    await env.gatewayApp.inject({
      method: "POST",
      url: `/__admin/groups/${gatewayGroupId}/inject`,
      payload: { code: "GROUP_WRITE_FORBIDDEN" },
    });
    // park a queued message for the other account first (acc-2 offline → stays queued)
    await env.pool.query(
      `INSERT INTO messages (group_id, client_msg_id, sender_account_id, is_own, text, sent_at, delivery_status)
       VALUES ($1,$2,'acc-2',true,'q',now(),'queued')`,
      [groupId, crypto.randomUUID()],
    );
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "t" },
    });
    const { clientMsgId } = res.json() as { clientMsgId: string };
    await waitFor(async () => (await messageRow(clientMsgId))?.delivery_status === "failed");
    const row = await messageRow(clientMsgId);
    expect(row.fail_code).toBe("GROUP_WRITE_FORBIDDEN");
    const { rows: g } = await env.pool.query("SELECT status FROM groups WHERE id=$1", [groupId]);
    expect(g[0]!.status).toBe("unreachable");
    const { rows: other } = await env.pool.query(
      "SELECT delivery_status, fail_code FROM messages WHERE group_id=$1 AND id<>$2",
      [groupId, row.id],
    );
    expect(other[0]).toMatchObject({
      delivery_status: "failed",
      fail_code: "GROUP_UNREACHABLE",
    });
    const { rows: acc } = await env.pool.query("SELECT status FROM accounts WHERE id='acc-1'");
    expect(acc[0]!.status).toBe("online");
  });
});

describe("inbound events", () => {
  it("S2: duplicate events are deduplicated", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/config",
      payload: { duplicateEvents: true },
    });
    await env.gatewayApp.inject({
      method: "POST",
      url: `/__admin/groups/${gatewayGroupId}/external-message`,
      payload: { platformUserId: "pu-ext-1", text: "hi" },
    });
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
        [groupId],
      );
      return rows[0]!.c === 1;
    });
    const { rows: evs } = await env.pool.query(
      "SELECT count(*)::int AS c FROM gateway_events WHERE type='message'",
    );
    expect(evs[0]!.c).toBe(1);
  });

  it("reordered events all land sorted by sentAt", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/config",
      payload: { reorderEvents: true },
    });
    for (let i = 0; i < 5; i++) {
      await env.gatewayApp.inject({
        method: "POST",
        url: `/__admin/groups/${gatewayGroupId}/external-message`,
        payload: { platformUserId: "pu-ext-1", text: `m${i}` },
      });
    }
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
        [groupId],
      );
      return rows[0]!.c === 5;
    }, 12000);
    const res = await env.app.inject({
      url: `/api/groups/${groupId}/messages`,
      headers: auth(token),
    });
    const sentAts = (res.json().items as Array<{ sentAt: string }>).map((i) =>
      new Date(i.sentAt).getTime(),
    );
    expect([...sentAts].sort((a, b) => b - a)).toEqual(sentAts);
  });

  it("account_status event -> terminal cascade", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token);
    await env.pool.query(
      `INSERT INTO messages (group_id, client_msg_id, sender_account_id, is_own, text, sent_at, delivery_status)
       VALUES ($1,$2,'acc-2',true,'q',now(),'queued')`,
      [groupId, crypto.randomUUID()],
    );
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-2/status",
      payload: { status: "suspended" },
    });
    await waitFor(async () => {
      const { rows } = await env.pool.query("SELECT status FROM accounts WHERE id='acc-2'");
      return rows[0]!.status === "suspended";
    });
    const { rows: members } = await env.pool.query(
      "SELECT * FROM group_members WHERE account_id='acc-2'",
    );
    expect(members).toHaveLength(0);
    const { rows: msgs } = await env.pool.query(
      "SELECT delivery_status, fail_code FROM messages WHERE sender_account_id='acc-2'",
    );
    expect(msgs[0]).toMatchObject({ delivery_status: "cancelled", fail_code: "ACCOUNT_TERMINAL" });
  });

  it("handler fault -> dead_events + inconsistency, stream continues", async () => {
    process.env.ENABLE_FAULT_INJECTION = "1";
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    env.app.ctx.faults.failNextEventHandler = true;
    await env.gatewayApp.inject({
      method: "POST",
      url: `/__admin/groups/${gatewayGroupId}/external-message`,
      payload: { platformUserId: "pu-ext-1", text: "bad" },
    });
    await waitFor(async () => {
      const { rows } = await env.pool.query("SELECT count(*)::int AS c FROM dead_events");
      return rows[0]!.c === 1;
    });
    const { rows: ws } = await env.pool.query(
      "SELECT type, payload FROM ws_events WHERE type='inconsistency'",
    );
    expect(ws[0]!.payload).toMatchObject({ kind: "event_processing_failed" });

    await env.gatewayApp.inject({
      method: "POST",
      url: `/__admin/groups/${gatewayGroupId}/external-message`,
      payload: { platformUserId: "pu-ext-1", text: "good" },
    });
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
        [groupId],
      );
      return rows[0]!.c === 1;
    });
    delete process.env.ENABLE_FAULT_INJECTION;
  });

  it("backfill after consumer restart catches up without duplicates", async () => {
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    workers = startWorkers(env.app.ctx);
    // let the consumer connect and persist a cursor
    await waitFor(async () => {
      const { rows } = await env.pool.query("SELECT watermark FROM gateway_cursor WHERE id=1");
      return rows.length === 1;
    });
    await workers.stop();
    workers = null;

    for (let i = 0; i < 3; i++) {
      await env.gatewayApp.inject({
        method: "POST",
        url: `/__admin/groups/${gatewayGroupId}/external-message`,
        payload: { platformUserId: "pu-ext-1", text: `offline-${i}` },
      });
    }
    workers = startWorkers(env.app.ctx);
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
        [groupId],
      );
      return rows[0]!.c === 3;
    });
    const { rows: c } = await env.pool.query(
      "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
      [groupId],
    );
    expect(c[0]!.c).toBe(3);
  });
});

describe("timeline pagination", () => {
  it("keyset pages with concurrent inserts: complete union, no dups", async () => {
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    for (let i = 0; i < 120; i++) {
      await env.pool.query(
        `INSERT INTO messages (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
         VALUES ($1,$2,'pu-ext-1',false,$3, now() + ($4 || ' milliseconds')::interval)`,
        [groupId, `m-${i}`, `msg-${i}`, i],
      );
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/api/groups/${groupId}/messages?limit=50${cursor ? `&before=${cursor}` : ""}`;
      const res = await env.app.inject({ url, headers: auth(token) });
      const body = res.json() as { items: Array<{ msgId: string }>; nextCursor: string | null };
      for (const it of body.items) seen.add(it.msgId);
      cursor = body.nextCursor;
      pages++;
      if (pages === 2) {
        // concurrent writes between pages must not shift the window
        for (let i = 0; i < 5; i++) {
          await env.gatewayApp.inject({
            method: "POST",
            url: `/__admin/groups/${gatewayGroupId}/external-message`,
            payload: { platformUserId: "pu-ext-1", text: `new-${i}` },
          });
        }
      }
    } while (cursor && pages < 10);
    expect(seen.size).toBe(120);
  });
});

describe("ws", () => {
  async function wsCollect(url: string, authMsg: object, count: number, timeoutMs = 5000) {
    const ws = new WebSocket(url);
    const frames: Array<{ seq?: number; type: string }> = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      ws.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        frames.push(f);
        if (frames.length >= count) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("open", () => ws.send(JSON.stringify(authMsg)));
      ws.on("error", reject);
    });
    ws.close();
    return frames;
  }

  it("bad auth -> success:false", async () => {
    await env.app.listen({ port: 0 });
    const port = (env.app.server.address() as { port: number }).port;
    const frames = await wsCollect(
      `ws://127.0.0.1:${port}/ws`,
      { type: "auth", accessToken: "bad" },
      1,
      3000,
    );
    expect(frames[0]).toMatchObject({ type: "auth", success: false, code: "UNAUTHORIZED" });
  });

  it("auth ok -> events pushed with increasing seq; sinceSeq replays", async () => {
    workers = startWorkers(env.app.ctx);
    await env.app.listen({ port: 0 });
    const port = (env.app.server.address() as { port: number }).port;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const { groupId } = await seedGroup(env, token);
    const res = await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "hi" },
    });
    expect(res.statusCode).toBe(202);

    const frames = await wsCollect(wsUrl, { type: "auth", accessToken: token }, 3, 6000);
    expect(frames[0]).toMatchObject({ type: "auth", success: true });
    const seqs = frames.slice(1).map((f) => f.seq!);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(seqs.length).toBeGreaterThanOrEqual(2);

    // Replay from a seq before these events: must see them again.
    const replay = await wsCollect(
      wsUrl,
      { type: "auth", accessToken: token, sinceSeq: 0 },
      2 + seqs.length,
      6000,
    );
    expect(replay[0]).toMatchObject({ type: "auth", success: true });
    expect(replay.length).toBeGreaterThanOrEqual(1 + seqs.length);
  });
});
