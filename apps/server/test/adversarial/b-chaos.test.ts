import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import type pg from "pg";
import {
  migrateAdvDb,
  resetAdvDb,
  startMocks,
  spawnServer,
  kill9,
  waitFor,
  login,
  gwAdmin,
  agentAdmin,
  gwState,
  type AdvEnv,
  type ServerHandle,
} from "./helpers.js";

/**
 * TEST_PLAN.md §B — 混沌注入 C1–C7。
 * 负载 ~45s：duplicateEvents + reorderEvents + SSE 每 2s 断线 + send 延迟 500–1500ms；
 * 期间并发：operator send ×20、5 步序列、agentEnabled 群 external-message ×30（顺带触发
 * agent 若干次）、另一个群 external-message ×5；WS 客户端中途主动断开一次带 sinceSeq 重连。
 * 之后 drain，再对 C1–C7 逐条断言。
 */

type GwSnapshot = Awaited<ReturnType<typeof gwState>>;

interface ChaosState {
  env: AdvEnv;
  server: ServerHandle;
  token: string;
  groupA: string;
  groupAGw: string;
  groupB: string;
  groupBGw: string;
  wsBaseline: number;
  wsSeqs: number[];
  ws: WebSocket | null;
  sendStatuses: number[];
  gw: GwSnapshot;
}

const S = {} as ChaosState;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** helpers.ts 的 api() 发小写 "bearer" 会被服务端 401，这里用规范 "Bearer"。 */
async function call(
  h: ServerHandle,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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

/** 与 helpers.ts 的 seedGroupAdv 相同，但 connect 走本文件的 call()（Bearer 大写）。 */
async function seedGroup(
  h: ServerHandle,
  env: AdvEnv,
  token: string,
  memberAccountIds: string[],
): Promise<{ groupId: string; gatewayGroupId: string }> {
  for (const id of ["acc-1", ...memberAccountIds]) {
    const res = await call(h, "POST", `/api/accounts/${id}/connect`, token);
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

function openWs(
  port: number,
  accessToken: string,
  sinceSeq: number,
  onEvent: (seq: number) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => reject(new Error("ws auth timeout")), 8000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", accessToken, sinceSeq }));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: { type?: string; success?: boolean; seq?: number };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "auth") {
        clearTimeout(timer);
        if (msg.success) resolve(ws);
        else reject(new Error("ws auth rejected"));
        return;
      }
      if (typeof msg.seq === "number") onEvent(msg.seq);
    };
  });
}

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
) {
  return S.env.pool.query<T>(sql, params);
}

/** 清理指向本 DB 的孤儿 server（spawnServer 只杀 npx 层，孙进程会泄漏）。 */
function killStaleServersOnDb(dbName: string): void {
  try {
    const out = execSync("ps -eo pid,ppid,command").toString();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m || !m[3]!.includes("loader.mjs src/server")) continue;
      if (m[2] !== "1") continue; // 只动孤儿，不碰还在测试中的进程
      const pid = Number(m[1]);
      try {
        const envline = execSync(`ps -E -ww -p ${pid} -o command`).toString();
        if (envline.includes(dbName)) process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  } catch {
    /* best effort */
  }
}

beforeAll(async () => {
  killStaleServersOnDb("gmp_adv_b");
  await migrateAdvDb();
  const env = await startMocks({
    gatewayConfig: {
      sendDelayMinMs: 500,
      sendDelayMaxMs: 1500,
      duplicateEvents: true,
      reorderEvents: true,
      disconnectEverySeconds: 2,
    },
  });
  S.env = env;
  await resetAdvDb(env.pool);
  S.server = await spawnServer(env);
  S.token = await login(S.server);

  // group A：operator send + 序列；group B：agentEnabled + 外部消息驱动 agent
  const a = await seedGroup(S.server, env, S.token, ["acc-2", "acc-3"]);
  S.groupA = a.groupId;
  S.groupAGw = a.gatewayGroupId;
  const b = await seedGroup(S.server, env, S.token, ["acc-4"]);
  S.groupB = b.groupId;
  S.groupBGw = b.gatewayGroupId;

  const patch = await call(S.server, "PATCH", `/api/groups/${S.groupB}`, S.token, {
    agentEnabled: true,
  });
  if (patch.status !== 200) throw new Error(`enable agent failed: ${JSON.stringify(patch.body)}`);

  // 每个 run：看一眼最近消息 → 回一条 → finish
  await agentAdmin(env, "POST", "/__admin/script", {
    runs: {
      "*": [
        { kind: "tool_use", name: "get_recent_messages", input: { limit: 10 } },
        {
          kind: "tool_use",
          name: "send_message",
          input: { text: "agent reply", idempotency_key: "k-reply" },
        },
        { kind: "tool_use", name: "finish", input: { summary: "done" } },
      ],
    },
  });

  S.wsSeqs = [];
  S.sendStatuses = [];
  S.gw = await gwState(env);
}, 90_000);

afterAll(async () => {
  try {
    S.ws?.close();
  } catch {
    /* ignore */
  }
  if (S.server) {
    kill9(S.server);
    // spawnServer 起的是 npx→tsx→node 三层进程，kill9 只杀 npx，留下持有
    // DB 连接和工作线程的孙进程；按监听端口补杀真正的 server。
    try {
      execSync(`lsof -ti tcp:${S.server.port} -sTCP:LISTEN | xargs kill -9`, {
        stdio: "ignore",
      });
    } catch {
      /* port already free */
    }
  }
  if (S.env) {
    await S.env.gatewayApp.close().catch(() => {});
    await S.env.agentApp.close().catch(() => {});
    await S.env.pool.end().catch(() => {});
  }
});

describe("B 混沌注入", () => {
  test("C0: 45s 混沌负载 + drain", async () => {
    // WS 客户端：sinceSeq=baseline 起连，~20s 时断开并按 lastSeq 重连
    const { rows: baseRows } = await q("SELECT COALESCE(max(seq),0)::int AS m FROM ws_events");
    S.wsBaseline = baseRows[0]!.m as number;
    console.log(`[C0] ws baseline=${S.wsBaseline}`);
    S.ws = await openWs(S.server.port, S.token, S.wsBaseline, (seq) => S.wsSeqs.push(seq));

    const jobs: Promise<unknown>[] = [];
    const at = (ms: number, fn: () => Promise<unknown>) =>
      jobs.push(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            void fn()
              .catch(() => {})
              .finally(resolve);
          }, ms),
        ),
      );

    // operator send ×20 → group A（acc-1/2/3 轮转）
    const opAccounts = ["acc-1", "acc-2", "acc-3"];
    for (let i = 0; i < 20; i++) {
      const acc = opAccounts[i % opAccounts.length]!;
      at(i * 2100 + (i % 5) * 130, async () => {
        const res = await call(S.server, "POST", `/api/groups/${S.groupA}/send`, S.token, {
          accountId: acc,
          text: `op-${i}`,
        });
        S.sendStatuses.push(res.status);
      });
    }

    // 外部消息 ×30 → group B（触发 agent run 链）
    for (let i = 0; i < 30; i++) {
      at(400 + i * 1400, () =>
        gwAdmin(S.env, "POST", `/__admin/groups/${S.groupBGw}/external-message`, {
          platformUserId: `ext-${i % 3}`,
          text: `ext-B-${i}`,
        }).then(() => {}),
      );
    }

    // 外部消息 ×5 → group A（不触发 agent）
    for (let i = 0; i < 5; i++) {
      at(2000 + i * 8000, () =>
        gwAdmin(S.env, "POST", `/__admin/groups/${S.groupAGw}/external-message`, {
          platformUserId: "ext-A",
          text: `ext-A-${i}`,
        }).then(() => {}),
      );
    }

    // 5 步序列 → group A
    at(1500, async () => {
      const seq = await call(S.server, "POST", "/api/sequences", S.token, {
        name: "chaos-seq",
        steps: [
          { index: 1, accountRole: "admin", text: "s1", delaySeconds: 1 },
          { index: 2, accountRole: "member", text: "s2", delaySeconds: 2 },
          { index: 3, accountRole: "admin", text: "s3", delaySeconds: 1 },
          { index: 4, accountRole: "member", text: "s4", delaySeconds: 2 },
          { index: 5, accountRole: "member", text: "s5", delaySeconds: 1 },
        ],
      });
      const sequenceId = (seq.body as { id: string }).id;
      const run = await call(
        S.server,
        "POST",
        `/api/groups/${S.groupA}/sequence-runs`,
        S.token,
        { sequenceId },
      );
      S.sendStatuses.push(run.status); // 期望 201
    });

    // WS 主动断开 + sinceSeq 重连
    at(20_000, async () => {
      S.ws?.close();
      await sleep(300);
      const last = S.wsSeqs.length ? S.wsSeqs[S.wsSeqs.length - 1]! : S.wsBaseline;
      console.log(`[C0] ws reconnect sinceSeq=${last}`);
      S.ws = await openWs(S.server.port, S.token, last, (seq) => S.wsSeqs.push(seq));
    });

    await Promise.all(jobs);

    // drain：所有 own 消息终态、无 running run/序列、事件消费追上网关
    await waitFor(
      async () => {
        const [{ rows: m }, { rows: ar }, { rows: sr }, { rows: ev }] = await Promise.all([
          q(
            `SELECT count(*)::int c FROM messages
              WHERE is_own AND delivery_status IN ('queued','sending','accepted','unknown')`,
          ),
          q("SELECT count(*)::int c FROM agent_runs WHERE status='running'"),
          q("SELECT count(*)::int c FROM sequence_runs WHERE status='running'"),
          q("SELECT count(*)::int c FROM gateway_events"),
        ]);
        const gw = await gwState(S.env);
        return m[0]!.c === 0 && ar[0]!.c === 0 && sr[0]!.c === 0 && ev[0]!.c === gw.events.length;
      },
      40_000,
      400,
    );

    S.gw = await gwState(S.env);
    console.log(
      `[C0] drain done. sendStatuses=${JSON.stringify(
        S.sendStatuses.reduce<Record<number, number>>((m, s) => {
          m[s] = (m[s] ?? 0) + 1;
          return m;
        }, {}),
      )} gwEvents=${S.gw.events.length}`,
    );
    // 给 WS pusher 一个周期把最后的事件推给重连的客户端
    await waitFor(
      async () => {
        const { rows } = await q("SELECT COALESCE(max(seq),0)::int m FROM ws_events");
        const last = S.wsSeqs.length ? S.wsSeqs[S.wsSeqs.length - 1]! : 0;
        return last >= (rows[0]!.m as number);
      },
      5_000,
      100,
    ).catch(() => {});
  }, 120_000);

  test("C1: (group_id,msg_id) 唯一，且网关每条消息在 DB 恰一行", async () => {
    const { rows: dup } = await q(
      `SELECT count(*)::int c FROM (
         SELECT 1 FROM messages WHERE msg_id IS NOT NULL
         GROUP BY group_id, msg_id HAVING count(*) > 1) t`,
    );
    expect(dup[0]!.c, "duplicate (group_id,msg_id) rows").toBe(0);

    // 单向映射：网关 messagesByGroup 里的每条消息在 DB 恰一行（同 msg_id）。
    // 注意 mock 的 external-message 只发 message 事件、不进 messagesByGroup，
    // 所以 DB 中可能有网关列表之外的外部消息行，不要求反向相等。
    const { rows: groups } = await q<{ id: string; gateway_group_id: string }>(
      "SELECT id, gateway_group_id FROM groups WHERE gateway_group_id IS NOT NULL",
    );
    let gwTotal = 0;
    for (const g of groups) {
      const gwMsgs = S.gw.messages.find((m) => m.groupId === g.gateway_group_id)?.messages ?? [];
      gwTotal += gwMsgs.length;
      const { rows: dbMsgs } = await q<{ msg_id: string; c: number }>(
        "SELECT msg_id, count(*)::int c FROM messages WHERE group_id=$1 AND msg_id IS NOT NULL GROUP BY msg_id",
        [g.id],
      );
      const dbByMsgId = new Map(dbMsgs.map((r) => [r.msg_id, r.c]));
      const missing: string[] = [];
      const dupRows: string[] = [];
      for (const m of gwMsgs) {
        const c = dbByMsgId.get(m.msgId);
        if (c === undefined) missing.push(m.msgId);
        else if (c !== 1) dupRows.push(`${m.msgId}x${c}`);
      }
      expect(missing, `group ${g.id} gateway msgs missing in DB`).toEqual([]);
      expect(dupRows, `group ${g.id} duplicate rows per msg_id`).toEqual([]);
    }
    expect(gwTotal).toBeGreaterThan(0);
  });

  test("C2: 每个 client_msg_id 在网关至多 1 条", async () => {
    const counts = new Map<string, number>();
    for (const g of S.gw.messages) {
      for (const m of g.messages) {
        if (!m.clientMsgId) continue;
        counts.set(m.clientMsgId, (counts.get(m.clientMsgId) ?? 0) + 1);
      }
    }
    const duplicated = [...counts.entries()].filter(([, c]) => c > 1);
    expect(duplicated).toEqual([]);
    expect(counts.size).toBeGreaterThan(0);
  });

  test("C3: 所有 own 消息终态 ∈ {sent,failed,cancelled}", async () => {
    const { rows } = await q<{ delivery_status: string; c: number }>(
      "SELECT delivery_status, count(*)::int c FROM messages WHERE is_own GROUP BY delivery_status",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(
        ["sent", "failed", "cancelled"].includes(r.delivery_status),
        `delivery_status=${r.delivery_status} count=${r.c}`,
      ).toBe(true);
    }
    const { rows: noCode } = await q(
      `SELECT count(*)::int c FROM messages
        WHERE is_own AND delivery_status IN ('failed','cancelled') AND fail_code IS NULL`,
    );
    expect(noCode[0]!.c).toBe(0);
  });

  test("C4: gateway_events 数 == 网关去重后事件数；dead_events 空", async () => {
    const { rows } = await q("SELECT count(*)::int c FROM gateway_events");
    expect(rows[0]!.c).toBe(S.gw.events.length);
    const { rows: dead } = await q("SELECT count(*)::int c FROM dead_events");
    expect(dead[0]!.c).toBe(0);
  });

  test("C5: 每个 active 群网关成员 == DB group_members", async () => {
    const { rows: groups } = await q<{ id: string; gateway_group_id: string }>(
      "SELECT id, gateway_group_id FROM groups WHERE status='active'",
    );
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      const gwMembers = new Set(
        (
          (S.gw.groups.find((x) => x.id === g.gateway_group_id)?.members ?? []) as unknown as {
            platformUserId: string;
          }[]
        ).map((m) => m.platformUserId),
      );
      const { rows: dbMembers } = await q<{ platform_user_id: string }>(
        "SELECT platform_user_id FROM group_members WHERE group_id=$1",
        [g.id],
      );
      expect(new Set(dbMembers.map((r) => r.platform_user_id)), `group ${g.id}`).toEqual(
        gwMembers,
      );
    }
  });

  test("C6: 同群 agent_runs 无时间重叠的 running", async () => {
    const { rows: running } = await q<{ group_id: string; c: number }>(
      "SELECT group_id, count(*)::int c FROM agent_runs WHERE status='running' GROUP BY group_id",
    );
    expect(running.filter((r) => r.c > 0)).toEqual([]);

    // 按 created_at 排序后，前一条 run 的 ended_at 不能超过下一条的 created_at；
    // running 的 run 后面不能再有 run（ended_at 视为 +∞）。
    const { rows: overlaps } = await q(
      `WITH r AS (
         SELECT id, group_id, status, created_at, ended_at,
                lag(ended_at) OVER w AS prev_ended,
                lag(status)   OVER w AS prev_status,
                lag(id)       OVER w AS prev_id
           FROM agent_runs
          WINDOW w AS (PARTITION BY group_id ORDER BY created_at, id)
       )
       SELECT id, prev_id FROM r
        WHERE prev_status = 'running'
           OR (prev_ended IS NOT NULL AND prev_ended > created_at)`,
    );
    expect(overlaps).toEqual([]);

    const { rows: runs } = await q("SELECT count(*)::int c FROM agent_runs");
    expect(runs[0]!.c).toBeGreaterThan(0);
  });

  test("C7: ws_events seq 连续递增，客户端收到的 seq 严格递增且补全", async () => {
    // DB 侧：seq 无洞
    const { rows: gaps } = await q(
      `SELECT count(*)::int c FROM (
         SELECT seq, lag(seq) OVER (ORDER BY seq) AS prev FROM ws_events) t
        WHERE prev IS NOT NULL AND seq <> prev + 1`,
    );
    expect(gaps[0]!.c).toBe(0);

    // 客户端侧：到达序严格递增、无重复
    expect(S.wsSeqs.length).toBeGreaterThan(0);
    for (let i = 1; i < S.wsSeqs.length; i++) {
      expect(S.wsSeqs[i], `seq[${i}] should be > seq[${i - 1}]`).toBeGreaterThan(
        S.wsSeqs[i - 1]!,
      );
    }
    expect(new Set(S.wsSeqs).size).toBe(S.wsSeqs.length);

    // 覆盖：第一次连接带 sinceSeq=baseline + 断线后 sinceSeq 重连 →
    // 收到的集合应等于 baseline 之后的全部 ws_events
    const { rows: dbSeqs } = await q<{ seq: string }>(
      "SELECT seq::bigint AS seq FROM ws_events WHERE seq > $1",
      [S.wsBaseline],
    );
    const expected = new Set(dbSeqs.map((r) => Number(r.seq)));
    const got = new Set(S.wsSeqs);
    const missing = [...expected].filter((s) => !got.has(s)).sort((a, b) => a - b);
    const extra = [...got].filter((s) => !expected.has(s)).sort((a, b) => a - b);
    expect(
      { missing, extra, baseline: S.wsBaseline },
      `baseline=${S.wsBaseline} first=${S.wsSeqs.slice(0, 8).join(",")}`,
    ).toEqual({ missing: [], extra: [], baseline: S.wsBaseline });
  });
});
