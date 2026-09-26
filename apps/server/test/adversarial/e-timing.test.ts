import crypto from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  migrateAdvDb,
  resetAdvDb,
  startMocks,
  spawnServer,
  kill9,
  waitFor,
  gwAdmin,
  agentAdmin,
  gwState,
  type AdvEnv,
  type ServerHandle,
} from "./helpers.js";

/**
 * docs/TEST_PLAN.md §E 前半（E1–E7 时序边界）。
 * 真实子进程 server（tsx）+ 进程内 mock gateway / mock agent，专属库 gmp_adv_e。
 *
 * 本地实现 callApi/seedGroup，保持与 e2-timing.test.ts 相同的结构，
 * 便于每个用例独立 spawn/kill server 子进程（E4a 需要停机重启）。
 */

let env: AdvEnv;
let server: ServerHandle | null = null;
const servers: ServerHandle[] = [];
const envs: AdvEnv[] = [];
let token = "";

beforeAll(async () => {
  await migrateAdvDb();
});

beforeEach(async () => {
  env = await startMocks();
  envs.push(env);
  await resetAdvDb(env.pool);
});

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    kill9(s);
    // 等进程真的退出，避免垂死 worker 写进下一个测试刚清空的表
    await new Promise<void>((r) => {
      s.proc.once("exit", () => r());
      setTimeout(r, 2000).unref();
    });
  }
  server = null;
  while (envs.length) {
    const e = envs.pop()!;
    await e.gatewayApp.close().catch(() => {});
    await e.agentApp.close().catch(() => {});
    await e.pool.end().catch(() => {});
  }
});

// ---------- local helpers ----------

async function callApi(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server!.base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function boot(extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  server = await spawnServer(env, extraEnv);
  servers.push(server);
  const r = await callApi("POST", "/api/auth/login", {
    body: { username: "admin", password: "admin" },
  });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  token = (r.body as { accessToken: string }).accessToken;
  return server;
}

/** seedGroupAdv equivalent with working Bearer auth. */
async function seedGroup(memberAccountIds: string[] = ["acc-2"], srv?: ServerHandle) {
  const s = srv ?? server!;
  for (const id of ["acc-1", ...memberAccountIds]) {
    const res = await fetch(`${s.base}/api/accounts/${id}/connect`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      if (body?.error?.code !== "ILLEGAL_TRANSITION") {
        throw new Error(`connect ${id}: ${res.status}`);
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

async function opSend(groupId: string, accountId: string, text: string): Promise<string> {
  const r = await callApi("POST", `/api/groups/${groupId}/send`, {
    token,
    body: { accountId, text },
  });
  if (r.status !== 202) throw new Error(`send ${text}: ${JSON.stringify(r.body)}`);
  return (r.body as { clientMsgId: string }).clientMsgId;
}

async function createSequence(
  steps: Array<{ index: number; accountRole: "admin" | "member"; text: string; delaySeconds: number }>,
): Promise<string> {
  const r = await callApi("POST", "/api/sequences", {
    token,
    body: { name: "adv-seq", steps },
  });
  if (r.status !== 201) throw new Error(`create seq: ${JSON.stringify(r.body)}`);
  return (r.body as { id: string }).id;
}

async function startSeqRun(groupId: string, sequenceId: string): Promise<string> {
  const r = await callApi("POST", `/api/groups/${groupId}/sequence-runs`, {
    token,
    body: { sequenceId },
  });
  if (r.status !== 201) throw new Error(`start run: ${JSON.stringify(r.body)}`);
  return (r.body as { runId: string }).runId;
}

interface SeqStepView {
  index: number;
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  clientMsgId: string | null;
  accountId: string | null;
}

async function seqRun(runId: string): Promise<{ status: string; steps: SeqStepView[] }> {
  const r = await callApi("GET", `/api/sequence-runs/${runId}`, { token });
  if (r.status !== 200) throw new Error(`seq run: ${JSON.stringify(r.body)}`);
  return r.body as { status: string; steps: SeqStepView[] };
}

interface MsgRow {
  id: string;
  msg_id: string | null;
  client_msg_id: string | null;
  sender_account_id: string | null;
  delivery_status: string | null;
  fail_code: string | null;
  resend_count: number;
  sent_at: Date;
}

async function msgRow(clientMsgId: string): Promise<MsgRow | null> {
  const { rows } = await env.pool.query<MsgRow>(
    "SELECT * FROM messages WHERE client_msg_id = $1",
    [clientMsgId],
  );
  return rows[0] ?? null;
}

async function accountStatus(id: string): Promise<string> {
  const { rows } = await env.pool.query<{ status: string }>(
    "SELECT status FROM accounts WHERE id=$1",
    [id],
  );
  return rows[0]!.status;
}

async function rateLimitedUntil(id: string): Promise<number | null> {
  const { rows } = await env.pool.query<{ rate_limited_until: Date | null }>(
    "SELECT rate_limited_until FROM accounts WHERE id=$1",
    [id],
  );
  return rows[0]?.rate_limited_until ? rows[0].rate_limited_until.getTime() : null;
}

async function sendCalls(accountId: string): Promise<number> {
  const st = await gwState(env);
  return st.accounts.find((a) => a.id === accountId)?.sendCalls ?? 0;
}

async function gwMessages(gatewayGroupId: string) {
  const st = await gwState(env);
  return st.messages.find((m) => m.groupId === gatewayGroupId)?.messages ?? [];
}

async function setAgentScript(runs: Record<string, unknown[]>) {
  await agentAdmin(env, "POST", "/__admin/script", { runs });
}

async function externalMessage(
  gatewayGroupId: string,
  platformUserId: string,
  text: string,
): Promise<string> {
  const r = await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-message`, {
    platformUserId,
    text,
  });
  return (r.body as { msgId: string }).msgId;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- E1–E7 ----------

describe("E 时序边界（1–7）", () => {
  it("E1 429 计时重置：限流窗口内该账号 sendCalls 不增长（网关对窗口内 send 会重置计时）", async () => {
    await boot();
    const { groupId, gatewayGroupId } = await seedGroup(["acc-2"]);
    await callApi("PATCH", `/api/groups/${groupId}`, {
      token,
      body: { agentEnabled: true },
    });
    await setAgentScript({
      "*": [
        {
          kind: "tool_use",
          name: "send_message",
          input: { text: "agent-msg", idempotency_key: "e1-k" },
        },
        { kind: "end_turn", text: "done" },
      ],
    });
    // once:true → 规则消费一次：首个 send 吃 429（retryAfter 2s），
    // 之后网关靠 rateLimitedUntil 继续 429 并重置计时；窗口外正常放行。
    await gwAdmin(env, "POST", "/__admin/accounts/acc-1/inject", {
      code: "RATE_LIMITED",
      retryAfterSeconds: 2,
      once: true,
    });

    const m1 = await opSend(groupId, "acc-1", "m1");
    await waitFor(async () => (await accountStatus("acc-1")) === "rate_limited");
    expect(await sendCalls("acc-1")).toBe(1);
    const until = (await rateLimitedUntil("acc-1"))!;
    expect(until).toBeGreaterThan(Date.now() + 500); // 窗口确实还在

    // 窗口内堆积：操作员 ×3 + 序列一步（顺延不跳过）+ agent send 一次（走 acc-2）
    const ops = [
      await opSend(groupId, "acc-1", "op1"),
      await opSend(groupId, "acc-1", "op2"),
      await opSend(groupId, "acc-1", "op3"),
    ];
    const seqId = await createSequence([
      { index: 1, accountRole: "admin", text: "seq-msg", delaySeconds: 0 },
    ]);
    const runId = await startSeqRun(groupId, seqId);
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");

    // 整个窗口内 acc-1 的 sendCalls 必须恒为 1 —— 任何一次放行都会让网关重置计时
    while (Date.now() < until - 200) {
      expect(await sendCalls("acc-1")).toBe(1);
      await sleep(120);
    }

    // 到期后：acc-1 恢复 online，5 条按 created_at 顺序排空；agent 走 acc-2
    const allIds = [m1, ...ops];
    await waitFor(
      async () => {
        for (const id of allIds) {
          if ((await msgRow(id))?.delivery_status !== "sent") return false;
        }
        const run = await seqRun(runId);
        return run.steps[0]?.status === "sent" && run.status === "finished";
      },
      20_000,
      100,
    );
    const stepMid = (await seqRun(runId)).steps[0]!.clientMsgId!;
    expect((await msgRow(stepMid))?.delivery_status).toBe("sent");

    const gwMsgs = await gwMessages(gatewayGroupId);
    // 网关侧恰 6 条：acc-1 五条 + agent 一条，无重复投递
    expect(gwMsgs).toHaveLength(6);
    const want = new Set<string>([...allIds, stepMid]);
    const mine = gwMsgs
      .map((m) => m.clientMsgId)
      .filter((c): c is string => c !== null && want.has(c));
    expect(mine).toEqual([m1, ...ops, stepMid]); // FIFO：429 的那条最先补发
    // mock 的 sendCalls 在 429 拒绝之前自增：1(429) + 5(acc-1 排空) + 1(agent)。
    // agent 的 send_message 在窗口内只能选 acc-2；若恰好跨过到期点选 acc-1 也合法。
    expect((await sendCalls("acc-1")) + (await sendCalls("acc-2"))).toBe(7);
    await waitFor(async () => (await accountStatus("acc-1")) === "online");
    // agent run 正常结束（audit 默认 pass）
    await waitFor(async () => {
      const { rows } = await env.pool.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM agent_runs WHERE group_id=$1 AND status='finished'",
        [groupId],
      );
      return rows[0]!.c === 1;
    });
  });

  it("E2 限流窗口内操作员标记 disconnected：到期不变回 online，queued 保持，connect 后按序发出", async () => {
    await boot();
    const { groupId, gatewayGroupId } = await seedGroup([]);
    await gwAdmin(env, "POST", "/__admin/accounts/acc-1/inject", {
      code: "RATE_LIMITED",
      retryAfterSeconds: 2,
      once: true,
    });
    const m1 = await opSend(groupId, "acc-1", "m1");
    await waitFor(async () => (await accountStatus("acc-1")) === "rate_limited");
    const until = (await rateLimitedUntil("acc-1"))!;
    const m2 = await opSend(groupId, "acc-1", "m2");

    // 窗口内标记离线：rate_limited -> disconnected 合法
    const tr = await callApi("POST", `/api/accounts/acc-1/transition`, {
      token,
      body: { to: "disconnected", expectedFrom: "rate_limited" },
    });
    expect(tr.status).toBe(200);

    // 到期（+余量）：不得回到 online；两条消息保持 queued
    await sleep(until - Date.now() + 500);
    expect(await accountStatus("acc-1")).toBe("disconnected");
    expect((await msgRow(m1))?.delivery_status).toBe("queued");
    expect((await msgRow(m2))?.delivery_status).toBe("queued");
    expect(await sendCalls("acc-1")).toBe(1); // 无人偷跑

    // connect 后按序发出（网关侧限流窗口也已过）
    const rc = await callApi("POST", `/api/accounts/acc-1/connect`, { token });
    expect(rc.status).toBe(200);
    await waitFor(
      async () =>
        (await msgRow(m1))?.delivery_status === "sent" &&
        (await msgRow(m2))?.delivery_status === "sent",
      15_000,
    );
    const landed = (await gwMessages(gatewayGroupId)).map((m) => m.clientMsgId);
    expect(landed).toEqual([m1, m2]);
    expect(await sendCalls("acc-1")).toBe(3); // 1×429 + 2×落地
  });

  it("E3 own 回流先于 message_sent（reorderEvents）：每消息恰一行，msgId+clientMsgId 齐全且 sent", async () => {
    await boot();
    await gwAdmin(env, "POST", "/__admin/config", { reorderEvents: true });
    const { groupId, gatewayGroupId } = await seedGroup([]);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await opSend(groupId, "acc-1", `r${i}`));

    await waitFor(
      async () => {
        const { rows } = await env.pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM messages WHERE group_id=$1 AND delivery_status='sent' AND msg_id IS NOT NULL AND client_msg_id IS NOT NULL",
          [groupId],
        );
        return rows[0]!.c === 12;
      },
      20_000,
      100,
    );
    // 每条消息恰好一行（回流占行已被 message_sent 合并，无残留双行）
    const { rows: cnt } = await env.pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
      [groupId],
    );
    expect(cnt[0]!.c).toBe(12);
    expect(await gwMessages(gatewayGroupId)).toHaveLength(12);

    // 确认乱序路径真的被覆盖：至少一对 (message 先到, message_sent 后到)
    const { rows: inv } = await env.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
         FROM gateway_events e1
         JOIN gateway_events e2
           ON e1.payload->>'msgId' = e2.payload->>'msgId'
        WHERE e1.type='message' AND e2.type='message_sent'
          AND e1.received_at < e2.received_at`,
    );
    expect(
      inv[0]!.c,
      "12 条消息没有出现一次 message 先于 message_sent 到达——乱序注入未生效",
    ).toBeGreaterThanOrEqual(1);
  });

  it("E4a 停机积压事件恢复后补投：按 sentAt 落位而非追加头部；外部补投允许触发 agent", async () => {
    // spec 场景：补投事件带新 eventId + 原 sentAt，可以比已收消息早任意时长。
    // mock 的 external-message 不支持自定义 sentAt（恒为 Date.now()），
    // 等价覆盖：(a) 真实停机期间积压 → 重启补投，验证“不按到达顺序排头部”；
    //          (b) 见 E4b，SQL 直插任意 sentAt 验证分页排序边界。
    await boot();
    const { groupId, gatewayGroupId } = await seedGroup([]);
    await callApi("PATCH", `/api/groups/${groupId}`, {
      token,
      body: { agentEnabled: true },
    });
    await setAgentScript({ "*": [{ kind: "end_turn", text: "done" }] });

    // 基线消息 R0：正常发出并落地
    const r0 = await opSend(groupId, "acc-1", "r0");
    await waitFor(async () => {
      const row = await msgRow(r0);
      return row?.delivery_status === "sent" && row.msg_id !== null;
    });
    const r0MsgId = (await msgRow(r0))!.msg_id!;
    // 等持久化游标存在，保证停机期间的事件能被 since 补拉
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT 1 FROM gateway_cursor WHERE id=1",
      );
      return rows.length === 1;
    });
    await sleep(600); // 让回流 message 事件也处理完（去重兜底）

    kill9(server!);
    await new Promise<void>((r) => {
      server!.proc.once("exit", () => r());
      setTimeout(r, 2000).unref();
    });

    // 停机期间：网关继续产生事件（sentAt=此刻），另有一条“已收到的消息” X（更晚 sentAt）
    const m1Id = await externalMessage(gatewayGroupId, "pu-ext-9", "backfill-1");
    await sleep(60);
    const m2Id = await externalMessage(gatewayGroupId, "pu-ext-9", "backfill-2");
    const emitSentAt = async (msgId: string) => {
      const st = await gwState(env);
      const ev = st.events.find(
        (e) => (e as { data?: { msgId?: string } }).data?.msgId === msgId,
      ) as { data: { sentAt: number } } | undefined;
      return ev!.data.sentAt;
    };
    const tEmit = [await emitSentAt(m1Id), await emitSentAt(m2Id)];
    const xMsgId = "m-late-local";
    await env.pool.query(
      `INSERT INTO messages (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at, delivery_status)
       VALUES ($1,$2,'pu-ext-x',false,'received-while-down',now(),NULL)`,
      [groupId, xMsgId],
    );

    // 重启：consumer 带 since=watermark 补投积压事件
    await boot();
    await waitFor(
      async () => {
        const { rows } = await env.pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM messages WHERE group_id=$1",
          [groupId],
        );
        return rows[0]!.c === 4;
      },
      15_000,
      100,
    );

    interface Item {
      msgId: string | null;
      sentAt: string;
    }
    const res = await callApi("GET", `/api/groups/${groupId}/messages`, { token });
    const items = (res.body as { items: Item[] }).items;
    expect(items).toHaveLength(4);
    // sentAt DESC：X（最晚）在头，R0（最早）在尾，补投的两条落在中间——
    // 若实现按到达顺序排头部，补投消息会出现在 X 之前。
    expect(items[0]!.msgId).toBe(xMsgId);
    expect(items[3]!.msgId).toBe(r0MsgId);
    const midIds = items.slice(1, 3).map((i) => i.msgId);
    expect([...midIds].sort()).toEqual([m1Id, m2Id].sort());
    // 补投行的 sentAt 保留网关原值（容差覆盖毫秒截断）
    for (const [i, t] of tEmit.entries()) {
      const it = items.find((x) => x.msgId === [m1Id, m2Id][i]);
      expect(Math.abs(new Date(it!.sentAt).getTime() - t)).toBeLessThanOrEqual(1000);
    }

    // 外部补投消息触发 agent（spec 未禁止）；own/SQL 行不产生 run
    await waitFor(
      async () => {
        const { rows } = await env.pool.query<{ c: number }>(
          "SELECT count(*)::int AS c FROM agent_runs WHERE group_id=$1 AND status='finished'",
          [groupId],
        );
        return rows[0]!.c === 2;
      },
      15_000,
      100,
    );
    const { rows: dead } = await env.pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM dead_events",
    );
    expect(dead[0]!.c).toBe(0);
  });

  it("E4b 分页排序边界：sentAt 早 1 小时的行落在末页；同毫秒行跨页不丢不重", async () => {
    // mock 无法产生任意 sentAt 的事件 → SQL 直插覆盖 spec 的极端情形。
    await boot();
    const { groupId } = await seedGroup([]);
    const now = Date.now();
    const rows = [
      { msgId: "e4-n2", sentAt: now }, // 最新，应在第 1 页头
      { msgId: "e4-n1", sentAt: now - 300_000 },
      // 三条同毫秒，故意让 page boundary 切在 tie 中间
      { msgId: "e4-t1", sentAt: now - 600_000 },
      { msgId: "e4-t2", sentAt: now - 600_000 },
      { msgId: "e4-t3", sentAt: now - 600_000 },
      { msgId: "e4-h2", sentAt: now - 1_800_000 },
      { msgId: "e4-h1", sentAt: now - 3_600_000 }, // 1 小时前 → 末页
    ];
    for (const r of rows) {
      await env.pool.query(
        `INSERT INTO messages (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
         VALUES ($1,$2,'pu-ext-9',false,$3,$4)`,
        [groupId, r.msgId, r.msgId, new Date(r.sentAt)],
      );
    }

    interface Page {
      items: Array<{ msgId: string | null; sentAt: string }>;
      nextCursor: string | null;
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = cursor ? `&before=${encodeURIComponent(cursor)}` : "";
      const res = await callApi("GET", `/api/groups/${groupId}/messages?limit=3${q}`, {
        token,
      });
      const body = res.body as Page;
      for (const it of body.items) seen.push(it.msgId!);
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3); // 7 条 / limit 3
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe("e4-n2");
    expect(seen[seen.length - 1]).toBe("e4-h1"); // 早 1 小时 → 末页不在头部
    // 整体 (sent_at DESC, id DESC)：同毫秒三条按 id 逆序排列
    const tieIdx = ["e4-t1", "e4-t2", "e4-t3"].map((m) => seen.indexOf(m));
    expect(tieIdx[0]!).toBeGreaterThan(tieIdx[1]!);
    expect(tieIdx[1]!).toBeGreaterThan(tieIdx[2]!);
    expect(seen.indexOf("e4-t3")).toBe(2); // tie 跨页：t3 在 p1，t2/t1 在 p2
  });

  it("E5 504 + by-client-id 503：不可用期间保持 unknown 不重发；恢复后限时定论", async () => {
    await boot();
    const { groupId, gatewayGroupId } = await seedGroup([]);
    await gwAdmin(env, "POST", "/__admin/accounts/acc-1/inject", {
      code: "NETWORK_TIMEOUT",
      once: true,
      actuallyDelivered: false,
    });
    const mid = await opSend(groupId, "acc-1", "m-504");
    await waitFor(async () => (await msgRow(mid))?.delivery_status === "unknown");
    expect(await sendCalls("acc-1")).toBe(1);

    // 全端点 503（含 by-client-id 与 /events）：~3s 内必须保持 unknown、不得重发。
    // 注意：503 在 mock 的 sendCalls 计数之前拦截，故“未重发”以 resend_count 为准。
    await gwAdmin(env, "POST", "/__admin/config", { unavailable: true });
    const until503 = Date.now() + 2900;
    while (Date.now() < until503) {
      const row = (await msgRow(mid))!;
      expect(row.delivery_status).toBe("unknown");
      expect(row.resend_count).toBe(0);
      await sleep(150);
    }

    await gwAdmin(env, "POST", "/__admin/config", { unavailable: false });
    const tRecover = Date.now();
    // spec：恢复后 2s 内必须变成 accepted/sent/failed 之一
    let resolvedAt = -1;
    await waitFor(
      async () => {
        const st = (await msgRow(mid))?.delivery_status;
        if (st && ["accepted", "sent", "failed"].includes(st)) {
          resolvedAt = Date.now();
          return true;
        }
        return false;
      },
      6_000,
      60,
    );
    const elapsed = resolvedAt - tRecover;
    expect(elapsed).toBeLessThanOrEqual(2000);

    // 确认未发出 → 只允许重发一次 → 最终 sent，网关恰 1 条
    await waitFor(async () => (await msgRow(mid))?.delivery_status === "sent", 15_000);
    const row = (await msgRow(mid))!;
    expect(row.resend_count).toBe(1);
    expect(await sendCalls("acc-1")).toBe(2); // 504 一次 + 重发一次
    expect(await gwMessages(gatewayGroupId)).toHaveLength(1);
  });

  it("E6 504 的消息在 ~1.9s 落地：不重发、最终 sent、网关恰 1 条", async () => {
    await boot();
    const { groupId, gatewayGroupId } = await seedGroup([]);
    await gwAdmin(env, "POST", "/__admin/accounts/acc-1/inject", {
      code: "NETWORK_TIMEOUT",
      once: true,
      actuallyDelivered: true,
      landDelayMs: 1900,
    });
    const mid = await opSend(groupId, "acc-1", "m-lands");
    await waitFor(async () => (await msgRow(mid))?.delivery_status === "unknown");

    // 落地前（<2s 网关收敛窗口内）不得提前宣判失败或重发
    await sleep(1200); // 距 504 ~1.3-1.5s，仍未到 1900ms 落地点
    const before = (await msgRow(mid))!;
    expect(before.delivery_status).toBe("unknown");
    expect(before.resend_count).toBe(0);

    await waitFor(
      async () => (await msgRow(mid))?.delivery_status === "sent",
      15_000,
      60,
    );
    const row = (await msgRow(mid))!;
    expect(row.resend_count).toBe(0);
    expect(row.msg_id).not.toBeNull();
    expect(await sendCalls("acc-1")).toBe(1); // 只发过一次
    expect(await gwMessages(gatewayGroupId)).toHaveLength(1);
  });

  it("E7 终态三来源等价：send 403 / account_status 事件 / 操作员 transition → 相同快照", async () => {
    interface Snap {
      accounts: Record<string, string>;
      members: Array<{ accountId: string | null; platformUserId: string; role: string }>;
      messages: Array<{
        text: string;
        sender: string | null;
        status: string | null;
        failCode: string | null;
      }>;
      seqSteps: Array<{ index: number; status: string }>;
      runStatus: string;
      wsTypes: string[];
      dead: number;
    }

    async function cycle(source: "send" | "event" | "operator"): Promise<Snap> {
      // 每轮全新 mock + server + DB：完全相同初始状态
      const e = await startMocks();
      envs.push(e);
      await resetAdvDb(e.pool);
      const srv = await spawnServer(e);
      servers.push(srv);
      server = srv;
      env = e;
      const lr = await callApi("POST", "/api/auth/login", {
        body: { username: "admin", password: "admin" },
      });
      token = (lr.body as { accessToken: string }).accessToken;

      const { groupId } = await seedGroup(["acc-2"], srv);
      // 阻流行：acc-2 有一条 'sending' → 其后所有 queued 按 NOT EXISTS 被挡住
      const blocker = crypto.randomUUID();
      await env.pool.query(
        `INSERT INTO messages (group_id, client_msg_id, sender_account_id, sender_platform_user_id,
           is_own, text, sent_at, delivery_status, sending_since)
         VALUES ($1,$2,'acc-2','pu-acc-2',true,'__blocker__',now(),'sending',now())`,
        [groupId, blocker],
      );
      // 三个来源都注入同样的规则（仅 'send' 来源会消费到）
      await gwAdmin(env, "POST", "/__admin/accounts/acc-2/inject", {
        code: "ACCOUNT_SUSPENDED",
        once: true,
      });
      const m1 = await opSend(groupId, "acc-2", "m1");
      const m2 = await opSend(groupId, "acc-2", "m2");
      const seqId = await createSequence([
        { index: 1, accountRole: "member", text: "mStep", delaySeconds: 0.5 },
      ]);
      const runId = await startSeqRun(groupId, seqId);
      // 等序列步把消息排进队列（accepted，被阻流行挡住）
      await waitFor(async () => {
        const r = await seqRun(runId);
        return r.steps[0]?.status === "accepted" && r.steps[0]?.clientMsgId !== null;
      });
      const mStep = (await seqRun(runId)).steps[0]!.clientMsgId!;
      // 等 setup 期 ws 事件落完，取水位线
      await waitFor(async () => {
        const { rows } = await env.pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM ws_events
            WHERE type='member_changed' AND payload->>'change'='joined'`,
        );
        return rows[0]!.c === 1;
      });
      const { rows: markerRows } = await env.pool.query<{ m: string | null }>(
        "SELECT max(seq) AS m FROM ws_events",
      );
      const marker = Number(markerRows[0]!.m ?? 0);

      if (source === "send") {
        // 放行阻流 → acc-2 的 m1 立即发出去吃 403 ACCOUNT_SUSPENDED
        await env.pool.query("DELETE FROM messages WHERE client_msg_id=$1", [blocker]);
      } else if (source === "event") {
        await gwAdmin(env, "POST", "/__admin/accounts/acc-2/status", {
          status: "suspended",
        });
      } else {
        const tr = await callApi("POST", `/api/accounts/acc-2/transition`, {
          token,
          body: { to: "suspended", expectedFrom: "online" },
        });
        expect(tr.status).toBe(200);
      }
      await waitFor(async () => (await accountStatus("acc-2")) === "suspended");
      // 清掉阻流 fixture（'send' 来源已在触发时删除）
      await env.pool.query("DELETE FROM messages WHERE client_msg_id=$1", [blocker]);
      await waitFor(async () => {
        const r = await seqRun(runId);
        return r.status === "finished";
      });
      await waitFor(async () => {
        for (const id of [m1, m2, mStep]) {
          if ((await msgRow(id))?.delivery_status !== "cancelled") return false;
        }
        return true;
      });
      // 等终态级联/网关推送产生的 member_changed(left) 落定：三个来源都是
      // 恰好 1 条（级联自己 emit；网关随后的 member_left 推送因行已删、
      // rowCount=0 被 consumer 去重不再 emit）。
      await waitFor(
        async () => {
          const { rows } = await env.pool.query<{ c: number }>(
            `SELECT count(*)::int AS c FROM ws_events
              WHERE type='member_changed' AND payload->>'change'='left' AND seq>$1`,
            [marker],
          );
          return rows[0]!.c === 1;
        },
        8_000,
      );

      const { rows: accRows } = await env.pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM accounts ORDER BY id",
      );
      const { rows: members } = await env.pool.query<{
        account_id: string | null;
        platform_user_id: string;
        role: string;
      }>(
        "SELECT account_id, platform_user_id, role FROM group_members WHERE group_id=$1 ORDER BY platform_user_id",
        [groupId],
      );
      const { rows: msgs } = await env.pool.query<{
        text: string;
        sender_account_id: string | null;
        delivery_status: string | null;
        fail_code: string | null;
      }>(
        "SELECT text, sender_account_id, delivery_status, fail_code FROM messages WHERE group_id=$1 ORDER BY text",
        [groupId],
      );
      const run = await seqRun(runId);
      const { rows: ws } = await env.pool.query<{ type: string }>(
        "SELECT type FROM ws_events WHERE seq>$1 ORDER BY seq",
        [marker],
      );
      const { rows: dead } = await env.pool.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM dead_events",
      );
      const snap: Snap = {
        accounts: Object.fromEntries(accRows.map((r) => [r.id, r.status])),
        members: members.map((m) => ({
          accountId: m.account_id,
          platformUserId: m.platform_user_id,
          role: m.role,
        })),
        messages: msgs.map((m) => ({
          text: m.text,
          sender: m.sender_account_id,
          status: m.delivery_status,
          failCode: m.fail_code,
        })),
        seqSteps: run.steps.map((s) => ({ index: s.index, status: s.status })),
        runStatus: run.status,
        wsTypes: ws.map((w) => w.type),
        dead: dead[0]!.c,
      };
      // 本轮结束即清理：三个 cycle 各自独占 mocks+server，避免共享 DB 互相抢活
      kill9(srv);
      await new Promise<void>((r) => {
        srv.proc.once("exit", () => r());
        setTimeout(r, 2000).unref();
      });
      await e.gatewayApp.close().catch(() => {});
      await e.agentApp.close().catch(() => {});
      await e.pool.end().catch(() => {});
      server = null;
      return snap;
    }

    const snapSend = await cycle("send");
    const snapEvent = await cycle("event");
    const snapOperator = await cycle("operator");

    // 去掉 id/seq/时间戳后，三份状态快照必须一致
    expect(snapEvent.accounts).toEqual(snapSend.accounts);
    expect(snapOperator.accounts).toEqual(snapSend.accounts);
    expect(snapEvent.members).toEqual(snapSend.members);
    expect(snapOperator.members).toEqual(snapSend.members);
    expect(snapEvent.messages).toEqual(snapSend.messages);
    expect(snapOperator.messages).toEqual(snapSend.messages);
    expect(snapEvent.seqSteps).toEqual(snapSend.seqSteps);
    expect(snapOperator.seqSteps).toEqual(snapSend.seqSteps);
    expect(snapEvent.runStatus).toBe(snapSend.runStatus);
    expect(snapOperator.runStatus).toBe(snapSend.runStatus);
    expect(snapSend.dead).toBe(0);
    expect(snapEvent.dead).toBe(0);
    expect(snapOperator.dead).toBe(0);

    // spec：三来源的 ws_events type 序列必须完全一致。
    expect(snapEvent.wsTypes).toEqual(snapSend.wsTypes);
    expect(snapOperator.wsTypes).toEqual(snapSend.wsTypes);
    for (const s of [snapSend, snapEvent, snapOperator]) {
      expect(s.wsTypes).toContain("account_status_changed");
      expect(s.wsTypes).toContain("account_terminal");
      expect(s.accounts["acc-2"]).toBe("suspended");
      expect(s.accounts["acc-1"]).toBe("online");
      expect(s.messages).toHaveLength(3);
      for (const m of s.messages) {
        expect(m.status).toBe("cancelled");
        expect(m.failCode).toBe("ACCOUNT_TERMINAL");
      }
      expect(s.seqSteps).toEqual([{ index: 1, status: "skipped" }]);
      expect(s.runStatus).toBe("finished");
    }
  });
});
