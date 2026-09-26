import crypto from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
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
 * docs/TEST_PLAN.md §E 后半（E8–E13 时序边界）。
 * 真实子进程 server（tsx）+ 进程内 mock gateway / mock agent，专属库 gmp_adv。
 *
 * 本文件用本地 callApi() 而非共享 api()：一是需要 Cookie/Set-Cookie 支持
 * （E11/E12 会话用例）；二是 helpers.ts 的 api() 曾以小写 `bearer` 发授权头
 * 导致全部带 token 调用 401（已修复，这里不依赖它，避免回归牵连）。
 */

let env: AdvEnv;
let server: ServerHandle | null = null;
let token = "";
let refreshCookieR1 = "";

beforeAll(async () => {
  await migrateAdvDb();
});

beforeEach(async () => {
  env = await startMocks();
  await resetAdvDb(env.pool);
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = null;
    kill9(s);
    // wait for the process to actually die so a dying worker cannot write into
    // the next test's freshly truncated tables
    await new Promise<void>((r) => {
      s.proc.once("exit", () => r());
      setTimeout(r, 2000).unref();
    });
  }
  await env.gatewayApp.close().catch(() => {});
  await env.agentApp.close().catch(() => {});
  await env.pool.end().catch(() => {});
});

// ---------- local helpers ----------

interface ApiResult {
  status: number;
  body: unknown;
  setCookies: string[];
}

async function callApi(
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const res = await fetch(`${server!.base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
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
  return { status: res.status, body, setCookies: res.headers.getSetCookie() };
}

/** spawn server + login; stores token and the R1 refresh cookie pair. */
async function boot(extraEnv: Record<string, string> = {}): Promise<void> {
  server = await spawnServer(env, extraEnv);
  const r = await callApi("POST", "/api/auth/login", {
    body: { username: "admin", password: "admin" },
  });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  token = (r.body as { accessToken: string }).accessToken;
  const sc = r.setCookies.find((c) => c.startsWith("refresh_token="));
  if (!sc) throw new Error("login did not set refresh_token cookie");
  refreshCookieR1 = sc.split(";")[0]!;
}

/** seedGroupAdv equivalent, but with working Bearer auth. */
async function seedGroup(memberAccountIds: string[] = ["acc-2"]) {
  for (const id of ["acc-1", ...memberAccountIds]) {
    const res = await callApi("POST", `/api/accounts/${id}/connect`, { token });
    if (res.status !== 200) {
      const code = (res.body as { error?: { code?: string } }).error?.code;
      if (code !== "ILLEGAL_TRANSITION") {
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

async function agentGroup(memberIds = ["acc-2"]) {
  const { groupId, gatewayGroupId } = await seedGroup(memberIds);
  const res = await callApi("PATCH", `/api/groups/${groupId}`, {
    token,
    body: { agentEnabled: true },
  });
  if (res.status !== 200) throw new Error(`enable agent: ${JSON.stringify(res.body)}`);
  return { groupId, gatewayGroupId };
}

async function setScript(runs: Record<string, unknown[]>, audit?: unknown[]) {
  await agentAdmin(env, "POST", "/__admin/script", {
    runs,
    ...(audit ? { audit } : {}),
  });
}

interface AgentAdminState {
  turnCalls: Array<{ runId: string; body: unknown }>;
  turnCallsByRun: Record<string, Array<{ messages: unknown[] }>>;
  auditCalls: Array<{ body: { text?: string } }>;
}

async function agentState(): Promise<AgentAdminState> {
  return (await agentAdmin(env, "GET", "/__admin/state")) as AgentAdminState;
}

async function gwMessages(gatewayGroupId: string) {
  const st = await gwState(env);
  return st.messages.find((m) => m.groupId === gatewayGroupId)?.messages ?? [];
}

async function externalJoin(gatewayGroupId: string, platformUserId: string) {
  await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-join`, {
    platformUserId,
  });
}

async function externalMessage(gatewayGroupId: string, platformUserId: string, text: string) {
  await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-message`, {
    platformUserId,
    text,
  });
}

interface RunListItem {
  id: string;
  status: string;
  endReason: string | null;
}

interface StepView {
  seq: number;
  kind: string;
  toolUseId: string | null;
  name: string | null;
  input: Record<string, unknown> | null;
  resultSummary: string | null;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string | null;
}

interface RunDetail extends RunListItem {
  summary: string | null;
  steps: StepView[];
}

async function runs(groupId: string): Promise<RunListItem[]> {
  const res = await callApi("GET", `/api/groups/${groupId}/agent-runs`, { token });
  if (res.status !== 200) throw new Error(`agent-runs list: ${JSON.stringify(res.body)}`);
  return res.body as RunListItem[];
}

async function runDetail(runId: string): Promise<RunDetail> {
  const res = await callApi("GET", `/api/agent-runs/${runId}`, { token });
  if (res.status !== 200) throw new Error(`agent-run: ${JSON.stringify(res.body)}`);
  return res.body as RunDetail;
}

async function runRow(runId: string) {
  const { rows } = await env.pool.query<{
    status: string;
    end_reason: string | null;
    elapsed_ms: string;
  }>("SELECT status, end_reason, elapsed_ms FROM agent_runs WHERE id=$1", [runId]);
  return rows[0] ?? null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- E8–E13 ----------

describe("E 时序边界（8–13）", () => {
  it("E8 audit 3 次全部无结论（hang 超时）→ blocked/audit_blocked，审计等待计入 elapsed，此后不再调 /agent/turn", async () => {
    await boot();
    const { groupId, gatewayGroupId } = await agentGroup();
    await setScript(
      {
        "*": [
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "audited-send", idempotency_key: "k1" },
          },
        ],
      },
      // AUDIT_TIMEOUT_MS=1000（spawnServer 默认）：hang 让每次审计都超时无结论。
      [{ hang: true, times: 3 }],
    );
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");

    await waitFor(
      async () => {
        const rs = await runs(groupId);
        return rs.length === 1 && rs[0]!.status === "blocked";
      },
      30_000,
      100,
    );
    const runId = (await runs(groupId))[0]!.id;
    const run = await runDetail(runId);
    expect(run.endReason).toBe("audit_blocked");

    // spec A5.4：同一工具调用最多 3 次审计尝试；3 次无结论 → blocked。
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(3);
    // 该 run 只发起过一次 /agent/turn（审计重试不算步）。
    expect(st.turnCallsByRun[runId]).toHaveLength(1);
    // 记一步 tool_use，auditVerdict=indeterminate，未执行。
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]!.name).toBe("send_message");
    expect(run.steps[0]!.auditVerdict).toBe("indeterminate");

    // spec A5.2：等审计的时间计入 60s 时钟。3 次 × ~1000ms 超时 ≈ 3s。
    const row = await runRow(runId);
    expect(Number(row!.elapsed_ms)).toBeGreaterThanOrEqual(2900);
    // 上限同样有意义：若审计等待被重复记账（例如 endRun 又加了一遍 claim 时长）
    // elapsed 会 ~6s。spec 要求按真实耗时累计。
    expect(Number(row!.elapsed_ms)).toBeLessThan(5000);

    // blocked 是终态：不再调 /agent/turn。
    await sleep(1500);
    expect((await agentState()).turnCallsByRun[runId]).toHaveLength(1);
    // 工具未执行：网关没有这条消息。
    expect(await gwMessages(gatewayGroupId)).toHaveLength(0);
    // 通知操作员：ws_events 里有 audit_blocked 不一致事件。
    const { rows: ws } = await env.pool.query(
      "SELECT 1 FROM ws_events WHERE type='inconsistency' AND payload->>'kind'='audit_blocked'",
    );
    expect(ws.length).toBe(1);
  });

  it("E9 同一 idempotency_key：AUDIT_REJECTED 不消耗 key；第二次真发；第三次幂等回放不再审计", async () => {
    await boot();
    const { groupId, gatewayGroupId } = await agentGroup();
    await setScript(
      {
        "*": [
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "idem-body", idempotency_key: "k1" },
          },
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "idem-body", idempotency_key: "k1" },
          },
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "idem-body", idempotency_key: "k1" },
          },
          { kind: "end_turn", text: "done" },
        ],
      },
      // 第一次审计 fail → AUDIT_REJECTED；times:1 用尽后回落默认 pass。
      [{ match: "idem-body", verdict: "fail", times: 1 }],
    );
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");

    await waitFor(
      async () => (await runs(groupId))[0]?.status === "finished",
      30_000,
      100,
    );
    const runId = (await runs(groupId))[0]!.id;
    const run = await runDetail(runId);
    expect(run.endReason).toBe("final");

    const sendSteps = run.steps.filter((s) => s.name === "send_message");
    expect(sendSteps).toHaveLength(3);
    // 1st: 审计 fail → AUDIT_REJECTED，key 不消耗。
    expect(sendSteps[0]!.isError).toBe(true);
    expect(sendSteps[0]!.errorCode).toBe("AUDIT_REJECTED");
    expect(sendSteps[0]!.auditVerdict).toBe("fail");
    // 2nd: key 没被消耗 → 再审计 → pass → 真发。
    expect(sendSteps[1]!.isError).toBe(false);
    expect(sendSteps[1]!.auditVerdict).toBe("pass");
    // 3rd: 幂等回放 → 不审计。
    expect(sendSteps[2]!.isError).toBe(false);
    expect(sendSteps[2]!.auditVerdict).toBeNull();

    // 审计总次数 == 2（fail 一次 + pass 一次）。
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(2);

    // 网关恰好一条消息，clientMsgId == 幂等表记录。
    await waitFor(async () => (await gwMessages(gatewayGroupId)).length === 1, 5000);
    const gw = await gwMessages(gatewayGroupId);
    const { rows: idem } = await env.pool.query<{ client_msg_id: string }>(
      "SELECT client_msg_id FROM agent_idempotency WHERE run_id=$1 AND key='k1'",
      [runId],
    );
    expect(idem).toHaveLength(1);
    expect(gw[0]!.clientMsgId).toBe(idem[0]!.client_msg_id);
  });

  it("E10 run 进行中 PATCH agentEnabled=false → 当前步完成后 cancelled；pending 消息被丢弃不产新 run", async () => {
    await boot();
    const { groupId, gatewayGroupId } = await agentGroup();
    await setScript({
      "*": [
        {
          // 拖长第 1 步，保证 PATCH 落在步中
          kind: "delay",
          ms: 1200,
          then: { kind: "tool_use", name: "get_recent_messages", input: { limit: 5 } },
        },
        { kind: "end_turn", text: "never reached" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId)).length === 1);
    const runId = (await runs(groupId))[0]!.id;
    // 等到第 1 步真的在飞行中（/agent/turn 已发出）
    await waitFor(async () => {
      const st = await agentState();
      return (st.turnCallsByRun[runId] ?? []).length === 1;
    });

    // run 进行中到达的外部消息 → 记 pending（同群 running run 唯一约束）
    await externalMessage(gatewayGroupId, "pu-ext-1", "during-run");
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT 1 FROM agent_pending_messages WHERE run_group_id=$1",
        [groupId],
      );
      return rows.length === 1;
    });

    const patch = await callApi("PATCH", `/api/groups/${groupId}`, {
      token,
      body: { agentEnabled: false },
    });
    expect(patch.status).toBe(200);

    // 当前步完成后整 run cancelled
    await waitFor(async () => (await runRow(runId))?.status === "cancelled", 15_000);
    const run = await runDetail(runId);
    expect(run.endReason).toBe("cancelled");
    // 当前步（get_recent_messages）已完整记完，之后不再有 turn
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]!.name).toBe("get_recent_messages");
    const st = await agentState();
    expect(st.turnCallsByRun[runId]).toHaveLength(1);

    // pending 被丢弃：不产新 run、不留垃圾
    const { rows: pend } = await env.pool.query(
      "SELECT 1 FROM agent_pending_messages WHERE run_group_id=$1",
      [groupId],
    );
    expect(pend).toHaveLength(0);
    // 取消后群已禁用，再来外部消息也不产 run/pending
    await externalMessage(gatewayGroupId, "pu-ext-1", "after-cancel");
    await sleep(1200);
    expect(await runs(groupId)).toHaveLength(1);
    const { rows: pend2 } = await env.pool.query(
      "SELECT count(*)::int AS c FROM agent_pending_messages",
    );
    expect(pend2[0]!.c).toBe(0);
  });

  it("E11 refresh token 复用 → 401 且整个会话作废（新旧 access、新 refresh 全部失效）", async () => {
    await boot();
    // login 已存 token=A1 / refreshCookieR1=R1
    const a1 = token;
    const r1 = refreshCookieR1;

    // refresh(R1) → 轮换得 A2 + R2
    const rr = await callApi("POST", "/api/auth/refresh", { cookie: r1 });
    expect(rr.status).toBe(200);
    const a2 = (rr.body as { accessToken: string }).accessToken;
    const sc2 = rr.setCookies.find((c) => c.startsWith("refresh_token="));
    expect(sc2).toBeTruthy();
    const r2 = sc2!.split(";")[0]!;
    expect(r2).not.toBe(r1);
    // sanity：A2 此刻可用
    expect((await callApi("GET", "/api/accounts", { token: a2 })).status).toBe(200);

    // 用旧 R1 再 refresh → reuse 检测：401 + 整个 session 作废
    const reuse = await callApi("POST", "/api/auth/refresh", { cookie: r1 });
    expect(reuse.status).toBe(401);
    expect((reuse.body as { error?: { code?: string } }).error?.code).toBe("UNAUTHORIZED");

    // 刚换出的 access token A2 立即失效；旧 A1 同 session 一并失效
    expect((await callApi("GET", "/api/accounts", { token: a2 })).status).toBe(401);
    expect((await callApi("GET", "/api/accounts", { token: a1 })).status).toBe(401);
    // 新 refresh token R2 也作废
    expect((await callApi("POST", "/api/auth/refresh", { cookie: r2 })).status).toBe(401);
  });

  it("E12 logout 后原 access token 立即 401（REST + WS auth 帧 + refresh cookie）", async () => {
    await boot();
    const a1 = token;
    const r1 = refreshCookieR1;
    // sanity：logout 前可用
    expect((await callApi("GET", "/api/accounts", { token: a1 })).status).toBe(200);

    const out = await callApi("POST", "/api/auth/logout", { cookie: r1 });
    expect(out.status).toBe(204);

    // access token 立即失效
    expect((await callApi("GET", "/api/accounts", { token: a1 })).status).toBe(401);
    // refresh token 所在会话已作废
    expect((await callApi("POST", "/api/auth/refresh", { cookie: r1 })).status).toBe(401);

    // WS auth 帧用已失效的 access token → auth success:false（或连接被拒）
    const authResp = await new Promise<Record<string, unknown>>((resolve, _reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`);
      let done = false;
      const finish = (v: Record<string, unknown>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        finish({ timeout: true });
      }, 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", accessToken: a1 }));
      });
      ws.on("message", (data: Buffer) => {
        let msg: unknown = null;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          /* ignore */
        }
        finish((msg ?? { unparsable: true }) as Record<string, unknown>);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
      ws.on("error", () => finish({ wsError: true }));
      ws.on("close", () => finish({ closedWithoutAuthFrame: true }));
    });
    // 实现约定：先回 {type:'auth',success:false} 再关闭；不接受该 token 是必须项
    expect(authResp).toSatisfy(
      (m: Record<string, unknown>) =>
        (m.type === "auth" && m.success === false) || m.closedWithoutAuthFrame === true,
    );
  });

  it("E13 翻页期间新增 own 消息（sentAt 受理时刻→网关时刻）→ 各页并集恰为 120 条历史，无重复无遗漏", async () => {
    await boot();
    const { groupId } = await seedGroup([]); // 只有 acc-1（creator）

    // SQL 直插 120 条入站历史：sent_at 分布在过去（每 1s 一条，最近一条 ~80s 前）
    const base = new Date(Date.now() - 200_000);
    await env.pool.query(
      `INSERT INTO messages (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
       SELECT $1, 'hist-' || g, 'pu-ext-hist', false, 'history ' || g,
              $2::timestamptz + make_interval(secs => g)
         FROM generate_series(0, 119) g`,
      [groupId, base],
    );

    interface Page {
      items: Array<{ msgId: string | null; clientMsgId: string | null; sentAt: string }>;
      nextCursor: string | null;
    }
    const page = async (before?: string | null): Promise<Page> => {
      const q = before ? `&before=${encodeURIComponent(before)}` : "";
      const res = await callApi("GET", `/api/groups/${groupId}/messages?limit=50${q}`, {
        token,
      });
      if (res.status !== 200) throw new Error(`messages page: ${JSON.stringify(res.body)}`);
      return res.body as Page;
    };

    // 第 1 页（最新 50 条历史）
    const p1 = await page();
    expect(p1.items).toHaveLength(50);
    expect(p1.nextCursor).toBeTruthy();

    // 翻页期间：操作员发 5 条 own 消息；等它们经网关落地——
    // message_sent 会把 sent_at 从受理时刻改写成网关时刻
    const clientMsgIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await callApi("POST", `/api/groups/${groupId}/send`, {
        token,
        body: { accountId: "acc-1", text: `op-${i}` },
      });
      expect(r.status).toBe(202);
      clientMsgIds.push((r.body as { clientMsgId: string }).clientMsgId);
    }
    await waitFor(async () => {
      const { rows } = await env.pool.query<{ c: number }>(
        "SELECT count(*)::int AS c FROM messages WHERE client_msg_id = ANY($1::uuid[]) AND delivery_status='sent'",
        [clientMsgIds],
      );
      return rows[0]!.c === 5;
    }, 15_000);

    // 继续向旧方向翻页
    const p2 = await page(p1.nextCursor);
    const p3 = await page(p2.nextCursor);
    expect(p2.items).toHaveLength(50);
    expect(p3.items).toHaveLength(20);
    expect(p3.nextCursor).toBeNull();

    const all = [...p1.items, ...p2.items, ...p3.items];
    expect(all).toHaveLength(120);
    // 无重复：keyset 翻页不应因头部新增 5 条而重复/遗漏
    const msgIds = all.map((m) => m.msgId);
    expect(new Set(msgIds).size).toBe(120);
    // 并集恰为 120 条历史，own 消息不出现在旧方向页里
    for (const m of all) {
      expect(m.msgId).toMatch(/^hist-\d+$/);
      expect(m.clientMsgId).toBeNull();
    }
    const nums = new Set(all.map((m) => Number(m.msgId!.slice(5))));
    expect(nums.size).toBe(120);

    // sanity：头部重新拉一页，5 条 own 消息确实已在时间线最前
    const head = await page();
    expect(head.items.slice(0, 5).every((m) => clientMsgIds.includes(m.clientMsgId!))).toBe(
      true,
    );
    expect(head.items[5]!.msgId).toBe("hist-119");
  });
});
