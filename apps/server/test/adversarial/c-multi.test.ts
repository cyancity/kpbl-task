import { execSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
 * TEST_PLAN.md §C — 多实例：两个 server 进程共享同一个 DB、同一个 mock gateway、
 * 同一个 mock agent。每个用例独立起一对实例；SSE 事件流被两个实例同时消费，
 * worker（sender/jobs/agent/sequence）通过 DB 行 + SKIP LOCKED + 部分唯一索引互斥。
 *
 * 已知基建坑（本文件绕开，不改 helpers.ts）：
 * - helpers.ts 的 api() 发小写 "bearer"，服务端 Bearer 匹配大小写敏感 → 401；
 *   seedGroupAdv 内部也走 api()，同样不可用。这里用本地 call()/seedGroup()。
 * - kill9() 只杀掉 `npx` 包装进程，`tsx` 拉起的真实 server 进程仍监听端口；
 *   僵尸实例会继续消费共享 DB → 用 deepKill() 按 LISTEN 端口反查 PID。
 */

let env: AdvEnv;
let s1: ServerHandle;
let s2: ServerHandle;

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

async function connectAccounts(ids: string[], token: string): Promise<void> {
  for (const id of ids) {
    const res = await call(s1, "POST", `/api/accounts/${id}/connect`, token);
    if (res.status !== 200) {
      const code = (res.body as { error?: { code?: string } }).error?.code;
      if (code !== "ILLEGAL_TRANSITION") {
        throw new Error(`connect ${id}: ${JSON.stringify(res.body)}`);
      }
    }
  }
}

/** 与 helpers.ts 的 seedGroupAdv 相同，但 connect 走本文件的 call()（Bearer 大写）。 */
async function seedGroup(
  memberAccountIds: string[],
  token: string,
): Promise<{ groupId: string; gatewayGroupId: string }> {
  await connectAccounts(["acc-1", ...memberAccountIds], token);
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

function deepKill(h: ServerHandle | null): void {
  if (!h) return;
  kill9(h);
  try {
    // 只杀监听该端口的进程，避免误伤自己到该端口的客户端连接。
    const out = execSync(`lsof -ti tcp:${h.port} -sTCP:LISTEN`, { encoding: "utf8" }).trim();
    for (const pid of out.split("\n").map((p) => p.trim()).filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing listening */
  }
}

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
) {
  return env.pool.query<T>(sql, params);
}

beforeAll(async () => {
  await migrateAdvDb();
});

beforeEach(async () => {
  env = await startMocks();
  await resetAdvDb(env.pool);
  s1 = await spawnServer(env);
  s2 = await spawnServer(env);
});

afterEach(async () => {
  deepKill(s1);
  deepKill(s2);
  if (env) {
    await env.gatewayApp.close().catch(() => {});
    await env.agentApp.close().catch(() => {});
    await env.pool.end().catch(() => {});
  }
});

describe("C 多实例（两个 server 进程共享同一 DB）", () => {
  it("M1 (S7): 两个实例并发 POST sequence-runs → 恰好 1×201 + 1×409 SEQUENCE_ALREADY_RUNNING", async () => {
    const token = await login(s1);
    const { groupId } = await seedGroup(["acc-2"], token);

    const seq = await call(s1, "POST", "/api/sequences", token, {
      name: "m1-seq",
      // delay 60s：run 在整个断言窗口内保持 running（第一步远未到期）
      steps: [{ index: 1, accountRole: "member", text: "m1 hello", delaySeconds: 60 }],
    });
    expect(seq.status).toBe(201);
    const sequenceId = (seq.body as { id: string }).id;

    const [r1, r2] = await Promise.all([
      call(s1, "POST", `/api/groups/${groupId}/sequence-runs`, token, { sequenceId }),
      call(s2, "POST", `/api/groups/${groupId}/sequence-runs`, token, { sequenceId }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses, `statuses ${JSON.stringify([r1, r2])}`).toEqual([201, 409]);
    const winner = r1.status === 201 ? r1 : r2;
    const loser = r1.status === 201 ? r2 : r1;
    expect((winner.body as { runId?: string }).runId).toBeTruthy();
    expect((loser.body as { error?: { code?: string } }).error?.code).toBe(
      "SEQUENCE_ALREADY_RUNNING",
    );

    // DB 层面：同群恰好一个 running 序列运行
    const { rows: runs } = await q<{ id: string; status: string }>(
      "SELECT id, status FROM sequence_runs WHERE group_id=$1",
      [groupId],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("running");

    // 另一个实例的读路径也能看到 activeSequenceRunId（共享 DB 一致视图）
    const gv = await call(s2, "GET", `/api/groups/${groupId}`, token);
    expect((gv.body as { activeSequenceRunId: string | null }).activeSequenceRunId).toBe(
      runs[0]!.id,
    );
  });

  it("M2: 两个实例同消费事件流 — 同群 3 条连发外部消息 → 任时刻至多 1 个 running run，pending 合并进下一 run", async () => {
    const token = await login(s1);
    // 剧本极简：看一眼最近消息就结束；* 对所有 runId 生效（后续 run 走默认 end_turn）
    await agentAdmin(env, "POST", "/__admin/script", {
      runs: {
        "*": [
          { kind: "tool_use", name: "get_recent_messages", input: { limit: 10 } },
          { kind: "end_turn", text: "ack" },
        ],
      },
    });
    const { groupId, gatewayGroupId } = await seedGroup(["acc-2"], token);
    const patch = await call(s1, "PATCH", `/api/groups/${groupId}`, token, {
      agentEnabled: true,
    });
    expect(patch.status).toBe(200);

    const msgIds: string[] = [];
    for (const text of ["m2-a", "m2-b", "m2-c"]) {
      const r = await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-message`, {
        platformUserId: "pu-ext-1",
        text,
      });
      msgIds.push((r.body as { msgId: string }).msgId);
    }

    // 收敛条件：无 running run、pending 排空、3 条消息都被某个 run 的 triggerMessages 覆盖
    const settled = () =>
      (async () => {
        const { rows: runs } = await q<{ status: string; trigger_messages: { msgId: string }[] | null }>(
          "SELECT status, trigger_messages FROM agent_runs WHERE group_id=$1",
          [groupId],
        );
        if (!runs.length) return false;
        if (runs.some((r) => r.status === "running")) return false;
        const { rows: pend } = await q<{ c: number }>(
          "SELECT count(*)::int AS c FROM agent_pending_messages WHERE run_group_id=$1",
          [groupId],
        );
        const covered = new Set(
          runs.flatMap((r) => (r.trigger_messages ?? []).map((m) => m.msgId)),
        );
        return pend[0]!.c === 0 && msgIds.every((id) => covered.has(id));
      })();
    let ok = true;
    try {
      await waitFor(settled, 30_000);
    } catch {
      ok = false;
    }
    if (!ok) {
      const { rows: dump } = await q(
        "SELECT id, status, end_reason, trigger_messages, created_at, ended_at FROM agent_runs WHERE group_id=$1 ORDER BY created_at",
        [groupId],
      );
      const { rows: pend } = await q(
        "SELECT * FROM agent_pending_messages WHERE run_group_id=$1",
        [groupId],
      );
      expect.unreachable(
        `runs did not settle: runs=${JSON.stringify(dump)} pending=${JSON.stringify(pend)}`,
      );
    }

    const { rows: runs } = await q<{
      id: string;
      status: string;
      end_reason: string | null;
      trigger_messages: { msgId: string; sentAt: number }[] | null;
      created_at: Date;
      ended_at: Date | null;
    }>(
      "SELECT id, status, end_reason, trigger_messages, created_at, ended_at FROM agent_runs WHERE group_id=$1 ORDER BY created_at, id",
      [groupId],
    );
    expect(runs.length).toBeGreaterThanOrEqual(1);

    // 每个 run 都正常结束（end_turn → finished/final）
    for (const r of runs) {
      expect(r.status, `run ${r.id} status`).toBe("finished");
      expect(r.end_reason, `run ${r.id} endReason`).toBe("final");
    }

    // 同一群 never 有两个 running 时间窗重叠（A5.1，多实例也成立）：
    // 按 created_at 排序后，前一条的 ended_at 不得超过下一条的 created_at；
    // 前一条仍 running（ended_at NULL）时不得存在下一条。
    for (let i = 1; i < runs.length; i++) {
      const prev = runs[i - 1]!;
      expect(prev.ended_at, `run ${prev.id} never ended` ).not.toBeNull();
      expect(
        runs[i]!.created_at.getTime(),
        `run ${runs[i]!.id} started before ${prev.id} ended (${prev.ended_at?.toISOString()} > ${runs[i]!.created_at.toISOString()})`,
      ).toBeGreaterThanOrEqual(prev.ended_at!.getTime());
    }

    // pending 合并语义：3 条外部消息恰好各出现在一个 run 的 triggerMessages 里
    const triggered = runs.flatMap((r) => r.trigger_messages ?? []);
    expect(triggered.map((t) => t.msgId).sort()).toEqual([...msgIds].sort());
    expect(triggered).toHaveLength(3);
    // triggerMessages 按 sentAt 升序（spec 2.2）
    for (const r of runs) {
      const ts = (r.trigger_messages ?? []).map((m) => m.sentAt);
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    }

    // 两个实例消费同一事件流：时间线无重复行（事件去重）
    const { rows: msgCount } = await q<{ c: number }>(
      "SELECT count(*)::int AS c FROM messages WHERE group_id=$1 AND is_own=false",
      [groupId],
    );
    expect(msgCount[0]!.c).toBe(3);

    const gv = await call(s2, "GET", `/api/groups/${groupId}`, token);
    expect((gv.body as { activeAgentRunId: string | null }).activeAgentRunId).toBeNull();
  });

  it("M3: 同一 online 账号 20 条 operator send 跨两实例排队 → 网关 sendCalls==20，落地顺序 == 提交顺序", async () => {
    const token = await login(s1);
    const { groupId, gatewayGroupId } = await seedGroup(["acc-2"], token);
    // 固定 15ms send 延迟：落地顺序 == 网关收到 send 调用的顺序，FIFO 断言才忠实于
    // spec 的"按原顺序发出"（随机延迟下落地乱序是网关自身语义，不是服务端的问题）。
    // 15ms 也足够让发送方的 accepted 写库先于 message_sent 事件处理。
    await gwAdmin(env, "POST", "/__admin/config", {
      sendDelayMinMs: 15,
      sendDelayMaxMs: 15,
    });

    const clientMsgIds: string[] = [];
    const handles = [s1, s2];
    for (let i = 0; i < 20; i++) {
      const h = handles[i % 2]!;
      const res = await call(h, "POST", `/api/groups/${groupId}/send`, token, {
        accountId: "acc-2",
        text: `m3-${i}`,
      });
      expect(res.status, `send ${i}`).toBe(202);
      clientMsgIds.push((res.body as { clientMsgId: string }).clientMsgId);
    }

    // 等待：acc-2 恰好被调用 20 次 send，且 20 条 clientMsgId 全部落地
    const drained = () =>
      (async () => {
        const st = await gwState(env);
        const acc = st.accounts.find((a) => a.id === "acc-2");
        const msgs = st.messages.find((m) => m.groupId === gatewayGroupId)?.messages ?? [];
        const landed = clientMsgIds.filter((id) => msgs.some((m) => m.clientMsgId === id));
        return acc?.sendCalls === 20 && landed.length === 20;
      })();
    let ok = true;
    try {
      await waitFor(drained, 30_000);
    } catch {
      ok = false;
    }
    if (!ok) {
      const st = await gwState(env);
      const acc = st.accounts.find((a) => a.id === "acc-2");
      const msgs = st.messages.find((m) => m.groupId === gatewayGroupId)?.messages ?? [];
      const { rows: db } = await q(
        "SELECT client_msg_id, delivery_status, fail_code FROM messages WHERE group_id=$1 ORDER BY id",
        [groupId],
      );
      expect.unreachable(
        `drain failed: sendCalls=${acc?.sendCalls} landed=${msgs.length} db=${JSON.stringify(db)}`,
      );
    }

    // 两个实例的消费端各自处理 message_sent，DB 最终全部 sent
    await waitFor(async () => {
      const { rows } = await q<{ c: number }>(
        `SELECT count(*)::int AS c FROM messages
          WHERE group_id=$1 AND client_msg_id = ANY($2::uuid[]) AND delivery_status='sent'`,
        [groupId, clientMsgIds],
      );
      return rows[0]!.c === 20;
    }, 15_000);

    const st = await gwState(env);
    const acc = st.accounts.find((a) => a.id === "acc-2");
    // 无重复领取、无重发：sendCalls 恰好 20
    expect(acc?.sendCalls).toBe(20);
    const groupMsgs = (
      st.messages.find((m) => m.groupId === gatewayGroupId)?.messages ?? []
    ).filter((m) => m.clientMsgId !== null && clientMsgIds.includes(m.clientMsgId));
    expect(groupMsgs).toHaveLength(20);
    // 每个 clientMsgId 在网关恰好一条
    const counts = new Map<string, number>();
    for (const m of groupMsgs) {
      counts.set(m.clientMsgId!, (counts.get(m.clientMsgId!) ?? 0) + 1);
    }
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    // FIFO：落地顺序（网关 messages 数组序）必须等于提交顺序
    expect(
      groupMsgs.map((m) => m.clientMsgId),
      "gateway landing order != submission order",
    ).toEqual(clientMsgIds);
  });

  it("M4: 两实例都跑 job worker 时建群 job 每步只执行一次 → 网关只建 1 个群，promoteCalls ≤ 2", async () => {
    const token = await login(s1);
    await connectAccounts(["acc-1", "acc-2", "acc-3"], token);

    const res = await call(s1, "POST", "/api/groups", token, {
      creatorAccountId: "acc-1",
      memberAccountIds: ["acc-2", "acc-3"],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const { jobId, groupId } = res.body as { jobId: string; groupId: string };

    // 从另一个实例轮询 job（跨实例 DB 视图）
    let finished = true;
    try {
      await waitFor(async () => {
        const j = await call(s2, "GET", `/api/jobs/${jobId}`, token);
        const st = (j.body as { status?: string }).status;
        return st === "finished" || st === "failed";
      }, 30_000);
    } catch {
      finished = false;
    }
    const job = await call(s2, "GET", `/api/jobs/${jobId}`, token);
    const jb = job.body as { status: string; errors: { step: string; code: string }[] };
    expect(finished, `job stuck: ${JSON.stringify(jb)}`).toBe(true);
    expect(jb.status).toBe("finished");
    expect(jb.errors).toEqual([]);

    const st = await gwState(env);
    interface GwGroup {
      id: string;
      creatorAccountId: string;
      members: { platformUserId: string }[];
      promoteCalls: number;
    }
    const groups = st.groups as unknown as GwGroup[];
    // create 步只执行一次：网关侧恰好 1 个群
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.creatorAccountId).toBe("acc-1");
    // promote 步只执行一次（spec 上限 2）
    expect(g.promoteCalls).toBeGreaterThanOrEqual(1);
    expect(g.promoteCalls).toBeLessThanOrEqual(2);
    // join 步每个成员恰好一次
    const joins = (st.joinAttempts as unknown as { groupId: string; accountId: string }[]).filter(
      (a) => a.groupId === g.id,
    );
    expect(joins.map((j) => j.accountId).sort()).toEqual(["acc-2", "acc-3"]);
    // 网关成员 = 群主 + 2 成员
    expect(g.members.map((m) => m.platformUserId).sort()).toEqual([
      "pu-acc-1",
      "pu-acc-2",
      "pu-acc-3",
    ]);

    // DB 侧：群 active、成员表与网关一致、memberAccountIds[0] 提升为 admin
    await waitFor(async () => {
      const { rows } = await q("SELECT 1 FROM group_members WHERE group_id=$1", [groupId]);
      return rows.length === 3;
    });
    const { rows: members } = await q<{ account_id: string; role: string }>(
      "SELECT account_id, role FROM group_members WHERE group_id=$1 ORDER BY account_id",
      [groupId],
    );
    expect(Object.fromEntries(members.map((m) => [m.account_id, m.role]))).toEqual({
      "acc-1": "creator",
      "acc-2": "admin",
      "acc-3": "member",
    });
    const { rows: gRows } = await q<{ status: string; gateway_group_id: string }>(
      "SELECT status, gateway_group_id FROM groups WHERE id=$1",
      [groupId],
    );
    expect(gRows[0]!.status).toBe("active");
    expect(gRows[0]!.gateway_group_id).toBe(g.id);
  });
});
