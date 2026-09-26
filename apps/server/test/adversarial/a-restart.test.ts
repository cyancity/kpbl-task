/**
 * TEST_PLAN A 节：进程级崩溃恢复（真实 kill -9，不是函数级模拟）。
 *
 * 每个用例：spawn 真实 tsx server 进程（独立 DB、两个进程内 mock），
 * 在指定状态机时点 SIGKILL，停几秒后重新 spawn，断言 spec 要求的恢复不变量。
 *
 * 恢复延迟的下限由各 worker 的租约/陈旧阈值决定（agent_runs 30s、jobs /
 * sequence_runs 15s、sending 10s），所以恢复类 waitFor 一律给 45s。
 */
import { execSync } from "node:child_process";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  migrateAdvDb,
  resetAdvDb,
  startMocks,
  spawnServer,
  waitFor,
  api,
  login,
  gwAdmin,
  agentAdmin,
  gwState,
  seedGroupAdv,
  type AdvEnv,
  type ServerHandle,
} from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** startMocks 里的同款快配置；/__admin/reset 会把 config 打回默认慢值，需重放。 */
const FAST_GW = {
  sendDelayMinMs: 10,
  sendDelayMaxMs: 30,
  joinDelayMinMs: 10,
  joinDelayMaxMs: 50,
  kickDelayMinMs: 10,
  kickDelayMaxMs: 50,
};

let env: AdvEnv;
const servers: ServerHandle[] = [];

async function spawn(extraEnv?: Record<string, string>): Promise<ServerHandle> {
  const h = await spawnServer(env, extraEnv);
  servers.push(h);
  return h;
}

/**
 * spawnServer 起的是 `npx tsx`：h.proc 是 npm 包装进程，kill9 只杀包装，
 * 真正的 `node tsx src/server.ts` 孙进程会变孤儿继续跑 worker —— 必须按
 * 监听端口把真正的 server 进程也杀掉。
 */
function hardKill(h: ServerHandle): void {
  try {
    h.proc.kill("SIGKILL"); // npm 包装进程
  } catch {
    // already dead
  }
  try {
    const out = execSync(`lsof -nP -tiTCP:${h.port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const pid of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // lsof 无匹配时非零退出
  }
}

function gwConfig(patch: Record<string, unknown>) {
  return gwAdmin(env, "POST", "/__admin/config", patch);
}

beforeAll(async () => {
  await migrateAdvDb();
});

beforeEach(async () => {
  env = await startMocks();
  await resetAdvDb(env.pool);
  await gwAdmin(env, "POST", "/__admin/reset");
  await gwAdmin(env, "POST", "/__admin/config", FAST_GW);
  await agentAdmin(env, "POST", "/__admin/reset");
});

afterEach(async () => {
  for (const h of servers.splice(0)) {
    hardKill(h);
    await Promise.race([new Promise((r) => h.proc.once("exit", r)), sleep(1500)]);
  }
  await env.gatewayApp.close();
  await env.agentApp.close();
  await env.pool.end();
});

// ---------------------------------------------------------------- local helpers

async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await env.pool.query(sql, params);
  return rows as T[];
}

interface MsgRow {
  delivery_status: string | null;
  msg_id: string | null;
  resend_count: number;
}
const msgByClientId = (clientMsgId: string) =>
  q<MsgRow>(
    "SELECT delivery_status, msg_id, resend_count FROM messages WHERE client_msg_id=$1",
    [clientMsgId],
  ).then((r) => r[0]);

/** helpers.gwState 的声明类型落后于 mock 实际返回（members 是对象数组且带 promoteCalls）。 */
interface GwStateFull {
  accounts: { id: string; sendCalls: number; connected: boolean }[];
  groups: {
    id: string;
    members: { platformUserId: string; accountId: string | null; role: string }[];
    promoteCalls: number;
  }[];
  messages: { groupId: string; messages: { msgId: string; clientMsgId: string | null }[] }[];
}
const gwFull = () => gwState(env) as unknown as Promise<GwStateFull>;

/** 网关侧实际落地的消息条数（clientMsgId 维度）。 */
function gwLandCount(state: GwStateFull, clientMsgId: string): number {
  let n = 0;
  for (const g of state.messages)
    for (const m of g.messages) if (m.clientMsgId === clientMsgId) n++;
  return n;
}

function sendCallsOf(state: GwStateFull, accountId: string): number {
  return state.accounts.find((a) => a.id === accountId)?.sendCalls ?? 0;
}

interface JobStateProbe {
  p: string | null;
  ggid: string | null;
  link: string | null;
}
const jobProbe = (jobId: string) =>
  q<JobStateProbe>(
    `SELECT state->>'phase' AS p, state->>'gatewayGroupId' AS ggid,
            state->>'inviteLink' AS link
       FROM jobs WHERE id=$1`,
    [jobId],
  ).then((r) => r[0]);

async function connectAll(h: ServerHandle, token: string, ids: string[]) {
  for (const id of ids) {
    const r = await api(h, "POST", `/api/accounts/${id}/connect`, token);
    expect(r.status).toBe(200);
  }
}

async function startGroupJob(
  h: ServerHandle,
  token: string,
): Promise<{ jobId: string; groupId: string }> {
  await connectAll(h, token, ["acc-1", "acc-2", "acc-3"]);
  const r = await api(h, "POST", "/api/groups", token, {
    creatorAccountId: "acc-1",
    memberAccountIds: ["acc-2", "acc-3"],
  });
  expect(r.status).toBe(202);
  return r.body as { jobId: string; groupId: string };
}

/** R2 公共断言：job finished 无 errors、网关只有 1 个群、promote ≤2、两边成员一致。 */
async function assertGroupJobDone(h: ServerHandle, jobId: string, groupId: string) {
  const token = await login(h);
  await waitFor(
    async () =>
      (await api(h, "GET", `/api/jobs/${jobId}`, token)).body !== null &&
      (
        (await api(h, "GET", `/api/jobs/${jobId}`, token)).body as {
          status?: string;
        }
      ).status === "finished",
    45_000,
    250,
  );
  const job = (
    await api(h, "GET", `/api/jobs/${jobId}`, token)
  ).body as { status: string; errors: { step: string; code: string }[] };
  expect(job.errors).toEqual([]);

  const st = await gwFull();
  expect(st.groups.length).toBe(1);
  expect(st.groups[0]!.promoteCalls).toBeLessThanOrEqual(2);
  const gwRoles = new Map(
    st.groups[0]!.members.map((m) => [m.platformUserId, m.role]),
  );
  expect(gwRoles.get("pu-acc-1")).toBe("owner");
  expect(gwRoles.get("pu-acc-2")).toBe("admin");
  expect(gwRoles.get("pu-acc-3")).toBe("member");

  const g = (
    await api(h, "GET", `/api/groups/${groupId}`, token)
  ).body as {
    status: string;
    members: { accountId: string | null; role: string }[];
  };
  expect(g.status).toBe("active");
  const roles = new Map(g.members.map((m) => [m.accountId, m.role]));
  expect(roles.get("acc-1")).toBe("creator");
  expect(roles.get("acc-2")).toBe("admin");
  expect(roles.get("acc-3")).toBe("member");
}

async function enableAgentAndTrigger(
  h: ServerHandle,
  token: string,
  groupId: string,
  gatewayGroupId: string,
): Promise<string> {
  const pr = await api(h, "PATCH", `/api/groups/${groupId}`, token, {
    agentEnabled: true,
  });
  expect(pr.status).toBe(200);
  await gwAdmin(env, "POST", `/__admin/groups/${gatewayGroupId}/external-message`, {
    platformUserId: "pu-ext",
    text: "hello agent",
  });
  await waitFor(
    async () =>
      (await q("SELECT id FROM agent_runs WHERE group_id=$1", [groupId])).length === 1,
    15_000,
    50,
  );
  return (await q<{ id: string }>("SELECT id FROM agent_runs WHERE group_id=$1", [groupId]))[0]!
    .id;
}

// ---------------------------------------------------------------- tests

describe("A. 进程级崩溃恢复 (kill -9)", () => {
  it("R1 send 在途崩溃：重启后消息最终 sent，网关恰好一条", async () => {
    // 拉长落地窗口，保证 kill 时消息不可能已到 sent。
    await gwConfig({ sendDelayMinMs: 1500, sendDelayMaxMs: 2000 });
    const h = await spawn();
    const token = await login(h);
    const { groupId } = await seedGroupAdv(h, env, token, ["acc-2"]);

    const res = await api(h, "POST", `/api/groups/${groupId}/send`, token, {
      accountId: "acc-1",
      text: "R1 crash-during-send",
    });
    expect(res.status).toBe(202);
    const clientMsgId = (res.body as { clientMsgId: string }).clientMsgId;

    // outbox 一离开 queued（worker 已领取，send HTTP 在途或刚回 202）就杀。
    // 观察到 sending 时命中"已 202 未写 accepted"窗口；赶上 accepted 时
    // 也是"已受理未落地"的合法崩溃点，两者断言同一组不变量。
    await waitFor(
      async () => {
        const r = await msgByClientId(clientMsgId);
        return !!r && r.delivery_status !== "queued";
      },
      10_000,
      4,
    );
    hardKill(h);
    await sleep(2500);

    const h2 = await spawn();
    await login(h2);

    await waitFor(
      async () => (await msgByClientId(clientMsgId))?.delivery_status === "sent",
      45_000,
      200,
    );
    const row = await msgByClientId(clientMsgId);
    expect(row?.delivery_status).toBe("sent");
    expect(row?.msg_id).not.toBeNull();

    const st = await gwFull();
    expect(sendCallsOf(st, "acc-1")).toBe(1); // 网关只收到一次 send
    expect(gwLandCount(st, clientMsgId)).toBe(1); // 也只落地一条
    const dup = await q<{ c: number }>(
      "SELECT count(*)::int c FROM messages WHERE client_msg_id=$1",
      [clientMsgId],
    );
    expect(dup[0]!.c).toBe(1);
    expect(row!.resend_count).toBeLessThanOrEqual(1);
  });

  it("R2 建群 job：create 后崩溃", async () => {
    const h = await spawn();
    const token = await login(h);
    const { jobId, groupId } = await startGroupJob(h, token);
    // 网关群已建成（gatewayGroupId 已持久化进 job state）就杀。
    await waitFor(async () => !!(await jobProbe(jobId))?.ggid, 10_000, 5);
    hardKill(h);
    await sleep(1500);
    const h2 = await spawn();
    await assertGroupJobDone(h2, jobId, groupId);
  });

  it("R2 建群 job：invite 后崩溃", async () => {
    // inviteReadyAfterMs 让 job 在 join 阶段等 readyAt，放大"invite 后"窗口。
    await gwConfig({ inviteReadyAfterMs: 2500 });
    const h = await spawn();
    const token = await login(h);
    const { jobId, groupId } = await startGroupJob(h, token);
    await waitFor(async () => !!(await jobProbe(jobId))?.link, 10_000, 5);
    hardKill(h);
    await sleep(1500);
    const h2 = await spawn();
    await assertGroupJobDone(h2, jobId, groupId);
  });

  it("R2 建群 job：join 请求发出后崩溃，member_joined 停机期间补投", async () => {
    // joinDelay 拉大 await 窗口：join 已 202 受理、member_joined 在路上时杀。
    await gwConfig({ joinDelayMinMs: 2500, joinDelayMaxMs: 3000 });
    const h = await spawn();
    const token = await login(h);
    const { jobId, groupId } = await startGroupJob(h, token);
    await waitFor(async () => (await jobProbe(jobId))?.p === "await", 10_000, 5);
    hardKill(h);
    // 停 3.5s：member_joined 全部落在停机窗口里，重启后只能靠事件补齐。
    await sleep(3500);
    const h2 = await spawn();
    await assertGroupJobDone(h2, jobId, groupId);
  });

  it("R2 建群 job：await_joins 中崩溃", async () => {
    await gwConfig({ joinDelayMinMs: 2500, joinDelayMaxMs: 3000 });
    const h = await spawn();
    const token = await login(h);
    const { jobId, groupId } = await startGroupJob(h, token);
    await waitFor(async () => (await jobProbe(jobId))?.p === "await", 10_000, 5);
    await sleep(1200); // await 窗口中段
    hardKill(h);
    await sleep(800);
    const h2 = await spawn();
    await assertGroupJobDone(h2, jobId, groupId);
  });

  it("R2 建群 job：promote 前崩溃", async () => {
    const h = await spawn();
    const token = await login(h);
    const { jobId, groupId } = await startGroupJob(h, token);
    // promote 阶段只有一个 worker tick（~200ms）的持久化窗口，高频轮询；
    // 追到 done 也说明 promote 已/未发出的边界，照常杀。
    await waitFor(async () => {
      const p = (await jobProbe(jobId))?.p;
      return p === "promote" || p === "done";
    }, 15_000, 5);
    hardKill(h);
    await sleep(1200);
    const h2 = await spawn();
    await assertGroupJobDone(h2, jobId, groupId);
  });

  it("R3 agent run 在 send_message executing 已提交、tool_result 未写时崩溃", async () => {
    await gwConfig({ sendDelayMinMs: 150, sendDelayMaxMs: 300 });
    await agentAdmin(env, "POST", "/__admin/script", {
      runs: {
        "*": [
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "r3 hello", idempotency_key: "k-r3" },
          },
          { kind: "end_turn", text: "done" },
        ],
      },
    });
    const h = await spawn();
    const token = await login(h);
    const { groupId, gatewayGroupId } = await seedGroupAdv(h, env, token, ["acc-2"]);
    const runId = await enableAgentAndTrigger(h, token, groupId, gatewayGroupId);

    // executing 步已提交（step 行 + 幂等行 + outbox 行已在一个 tx 落库）
    // 且网关已收到 send —— 此时 tool_result 一定还没写（finalize 才会写）。
    await waitFor(
      async () => {
        const s = await q(
          "SELECT 1 FROM agent_steps WHERE run_id=$1 AND state='executing' AND name='send_message'",
          [runId],
        );
        if (!s.length) return false;
        return sendCallsOf(await gwFull(), "acc-1") >= 1;
      },
      20_000,
      10,
    );
    hardKill(h);
    await sleep(2500);

    const h2 = await spawn();
    const token2 = await login(h2);
    await waitFor(
      async () =>
        (
          (await api(h2, "GET", `/api/agent-runs/${runId}`, token2)).body as {
            status?: string;
          }
        ).status === "finished",
      45_000,
      300,
    );

    const run = (
      await api(h2, "GET", `/api/agent-runs/${runId}`, token2)
    ).body as {
      status: string;
      endReason: string | null;
      steps: { seq: number; kind: string; name: string | null; isError: boolean }[];
    };
    // 同一个 runId 完成，endReason=final；steps 无重复行（seq 唯一且只有 2 步）。
    expect(run.status).toBe("finished");
    expect(run.endReason).toBe("final");
    expect(run.steps.map((s) => s.kind)).toEqual(["tool_use", "final"]);
    expect(new Set(run.steps.map((s) => s.seq)).size).toBe(run.steps.length);
    const totalRuns = await q<{ c: number }>(
      "SELECT count(*)::int c FROM agent_runs WHERE group_id=$1",
      [groupId],
    );
    expect(totalRuns[0]!.c).toBe(1);

    const cmid = (
      await q<{ client_msg_id: string }>(
        "SELECT client_msg_id FROM agent_steps WHERE run_id=$1 AND name='send_message'",
        [runId],
      )
    )[0]!.client_msg_id;
    const st = await gwFull();
    expect(gwLandCount(st, cmid)).toBe(1); // 网关只有一条，已产生的副作用不重放
    expect(sendCallsOf(st, "acc-1")).toBe(1); // 也没有重发
    const row = await msgByClientId(cmid);
    expect(row?.delivery_status).toBe("sent");
  });

  it("R4 agent run 时钟：停机时间不计入 elapsed_ms", async () => {
    // 三个各 ~2s 的 turn；第二步完成时 elapsed≈4-5s，第三步在途时 kill。
    await agentAdmin(env, "POST", "/__admin/script", {
      runs: {
        "*": [
          {
            kind: "delay",
            ms: 2000,
            then: { kind: "tool_use", name: "get_recent_messages", input: { limit: 5 } },
          },
          {
            kind: "delay",
            ms: 2000,
            then: { kind: "tool_use", name: "get_recent_messages", input: { limit: 5 } },
          },
          { kind: "delay", ms: 2000, then: { kind: "end_turn", text: "bye" } },
        ],
      },
    });
    const h = await spawn();
    const token = await login(h);
    const { groupId, gatewayGroupId } = await seedGroupAdv(h, env, token, ["acc-2"]);
    const runId = await enableAgentAndTrigger(h, token, groupId, gatewayGroupId);

    await waitFor(
      async () =>
        Number(
          (await q<{ elapsed_ms: number }>(
            "SELECT elapsed_ms FROM agent_runs WHERE id=$1",
            [runId],
          ))[0]?.elapsed_ms ?? 0,
        ) >= 3500,
      20_000,
      100,
    );
    hardKill(h);
    await sleep(8000); // 停机 8s —— 若被计入，elapsed 必然 >10s

    const h2 = await spawn();
    const token2 = await login(h2);
    await waitFor(
      async () =>
        (
          await q<{ status: string }>(
            "SELECT status FROM agent_runs WHERE id=$1",
            [runId],
          )
        )[0]?.status !== "running",
      45_000,
      300,
    );
    const row = (
      await q<{ status: string; end_reason: string | null; elapsed_ms: number }>(
        "SELECT status, end_reason, elapsed_ms FROM agent_runs WHERE id=$1",
        [runId],
      )
    )[0]!;
    expect(row.status).toBe("finished");
    expect(row.end_reason).not.toBe("wall_clock");
    expect(Number(row.elapsed_ms)).toBeLessThan(10_000);

    const apiRun = (
      await api(h2, "GET", `/api/agent-runs/${runId}`, token2)
    ).body as { status: string; endReason: string | null };
    expect(apiRun.status).toBe("finished");
    expect(apiRun.endReason).toBe("final");
    const totalRuns = await q<{ c: number }>(
      "SELECT count(*)::int c FROM agent_runs WHERE group_id=$1",
      [groupId],
    );
    expect(totalRuns[0]!.c).toBe(1);
  });

  it("R5 序列崩溃：过期步骤重排为重启时刻+delaySeconds，不立即补发", async () => {
    const h = await spawn();
    const token = await login(h);
    const { groupId } = await seedGroupAdv(h, env, token, ["acc-2"]);
    const seqRes = await api(h, "POST", "/api/sequences", token, {
      name: "r5",
      steps: [
        { index: 1, accountRole: "admin", text: "m1", delaySeconds: 0.5 },
        { index: 2, accountRole: "member", text: "m2", delaySeconds: 3 },
        { index: 3, accountRole: "member", text: "m3", delaySeconds: 0.5 },
      ],
    });
    expect(seqRes.status).toBe(201);
    const sequenceId = (seqRes.body as { id: string }).id;
    const runRes = await api(h, "POST", `/api/groups/${groupId}/sequence-runs`, token, {
      sequenceId,
    });
    expect(runRes.status).toBe(201);
    const runId = (runRes.body as { runId: string }).runId;

    const step = (index: number) =>
      q<{ status: string; sent_at: Date | null; client_msg_id: string | null }>(
        "SELECT status, sent_at, client_msg_id FROM sequence_run_steps WHERE run_id=$1 AND index=$2",
        [runId, index],
      ).then((r) => r[0]);

    await waitFor(async () => (await step(1))?.status === "sent", 15_000, 50);
    hardKill(h);
    await sleep(5000); // 停机 5s：第 2 步原 scheduled_at（sent1+3s）已过期

    const spawnBegin = Date.now(); // 重排下限：重启进程还不存在时不可能排期
    const h2 = await spawn();
    const token2 = await login(h2);

    await waitFor(async () => (await step(2))?.status === "sent", 30_000, 100);
    const s2 = (await step(2))!;
    const sent2 = s2.sent_at!.getTime();
    // B1：重启后只把最早过期步骤重排到「重启时刻 + 该步 delaySeconds」。
    expect(sent2).toBeGreaterThanOrEqual(spawnBegin + 2900);
    expect(sent2).toBeLessThan(spawnBegin + 15_000);

    await waitFor(async () => (await step(3))?.status === "sent", 15_000, 100);
    const s3 = (await step(3))!;
    // 第 3 步在第 2 步发出后 ~0.5s 链式排期，不允许跟着第 2 步一起喷出。
    const gap = s3.sent_at!.getTime() - sent2;
    expect(gap).toBeGreaterThanOrEqual(200);
    expect(gap).toBeLessThan(3000);

    await waitFor(
      async () =>
        (
          await q<{ status: string }>(
            "SELECT status FROM sequence_runs WHERE id=$1",
            [runId],
          )
        )[0]?.status === "finished",
      15_000,
      100,
    );
    const apiRun = (
      await api(h2, "GET", `/api/sequence-runs/${runId}`, token2)
    ).body as { status: string };
    expect(apiRun.status).toBe("finished");

    const st = await gwFull();
    expect(sendCallsOf(st, "acc-1")).toBe(1); // step1 by creator(admin 角色)
    expect(sendCallsOf(st, "acc-2")).toBe(2); // step2/3 by member
    for (const index of [1, 2, 3]) {
      const s = (await step(index))!;
      expect(gwLandCount(st, s.client_msg_id!)).toBe(1);
    }
  });

  it("R6 停机期间 20 个事件重启后全部补齐、无重复、agent 合并触发", async () => {
    await gwConfig({ duplicateEvents: true, reorderEvents: true });
    // run1 故意放慢（3s）：保证 20 个事件全部消费完才结束，pending 一次性并入 run2。
    await agentAdmin(env, "POST", "/__admin/script", {
      runs: {
        "*": [
          {
            kind: "delay",
            ms: 3000,
            then: {
              kind: "tool_use",
              name: "get_recent_messages",
              input: { limit: 50 },
            },
          },
          { kind: "end_turn", text: "done" },
        ],
      },
    });
    const h = await spawn();
    const token = await login(h);
    const { groupId, gatewayGroupId } = await seedGroupAdv(h, env, token, ["acc-2"]);
    const pr = await api(h, "PATCH", `/api/groups/${groupId}`, token, {
      agentEnabled: true,
    });
    expect(pr.status).toBe(200);
    await sleep(700); // 让 seeding 的 member_joined 在 kill 前消费掉
    hardKill(h);

    // 停机期间产生 20 个 message 事件（dup/reorder 开关已开；
    // 无 live SSE 客户端时它们只进网关事件历史，重启后由 ?since 重放）。
    const msgIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await gwAdmin(
        env,
        "POST",
        `/__admin/groups/${gatewayGroupId}/external-message`,
        { platformUserId: "pu-ext", text: `ext-${i}` },
      );
      msgIds.push((r.body as { msgId: string }).msgId);
    }

    const h2 = await spawn();
    await login(h2);

    await waitFor(
      async () =>
        (
          await q<{ c: number }>(
            "SELECT count(*)::int c FROM messages WHERE group_id=$1 AND is_own=false",
            [groupId],
          )
        )[0]!.c === 20,
      45_000,
      200,
    );
    await waitFor(
      async () =>
        (
          await q<{ c: number }>(
            "SELECT count(*)::int c FROM agent_runs WHERE group_id=$1 AND status='running'",
            [groupId],
          )
        )[0]!.c === 0,
      45_000,
      300,
    );

    // 全部落库且无重复行（(group_id,msg_id) 唯一）。
    const ids = await q<{ msg_id: string }>(
      "SELECT msg_id FROM messages WHERE group_id=$1 AND is_own=false",
      [groupId],
    );
    expect(ids.length).toBe(20);
    expect(new Set(ids.map((r) => r.msg_id)).size).toBe(20);
    // gateway_events 恰好 20 条 message（唯一约束吸收重复投递）。
    const ev = await q<{ c: number }>(
      "SELECT count(*)::int c FROM gateway_events WHERE type='message' AND payload->>'groupId'=$1",
      [gatewayGroupId],
    );
    expect(ev[0]!.c).toBe(20);
    const dead = await q<{ c: number }>("SELECT count(*)::int c FROM dead_events");
    expect(dead[0]!.c).toBe(0);

    // agent 不按消息逐条触发：第 1 条起 run，其余 19 条 pending 并入下一个 run，
    // 总共 2 个 run，trigger 集合恰好覆盖 20 条、各一次。
    const runs = await q<{
      status: string;
      end_reason: string | null;
      trigger_messages: { msgId: string }[] | null;
    }>(
      "SELECT status, end_reason, trigger_messages FROM agent_runs WHERE group_id=$1 ORDER BY created_at",
      [groupId],
    );
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === "finished")).toBe(true);
    const trig = runs.flatMap((r) => (r.trigger_messages ?? []).map((m) => m.msgId));
    expect(new Set(trig).size).toBe(20);
    for (const id of msgIds) expect(trig).toContain(id);
  });

  it("R7 unknown 对账崩溃：重启后 5s 内定论、不双发", async () => {
    const h = await spawn();
    const token = await login(h);
    const { groupId } = await seedGroupAdv(h, env, token, ["acc-2"]);
    // 504 但实际 1.5s 后落地 —— 落地点安排在停机窗口内。
    await gwAdmin(env, "POST", "/__admin/accounts/acc-1/inject", {
      code: "NETWORK_TIMEOUT",
      actuallyDelivered: true,
      landDelayMs: 1500,
    });
    const res = await api(h, "POST", `/api/groups/${groupId}/send`, token, {
      accountId: "acc-1",
      text: "r7 unknown crash",
    });
    expect(res.status).toBe(202);
    const clientMsgId = (res.body as { clientMsgId: string }).clientMsgId;

    await waitFor(
      async () => (await msgByClientId(clientMsgId))?.delivery_status === "unknown",
      10_000,
      5,
    );
    hardKill(h); // 杀死时网关侧尚未落地（landDelay 1500ms）
    await sleep(2500); // 停机期间网关落地、message_sent 进历史

    const h2 = await spawn();
    await login(h2);
    const upAt = Date.now();
    // 重启后 5s 内必须定论（脱离 unknown）。
    await waitFor(
      async () => {
        const s = (await msgByClientId(clientMsgId))?.delivery_status;
        return s === "accepted" || s === "sent";
      },
      5_000,
      50,
    );
    // 随后 message_sent 补投把它推成 sent。
    await waitFor(
      async () => (await msgByClientId(clientMsgId))?.delivery_status === "sent",
      15_000,
      100,
    );
    const settledIn = Date.now() - upAt;
    expect(settledIn).toBeLessThan(15_000);

    const row = await msgByClientId(clientMsgId);
    expect(row?.delivery_status).toBe("sent");
    expect(row?.resend_count).toBe(0); // 已落地的消息绝不允许重发
    const st = await gwFull();
    expect(sendCallsOf(st, "acc-1")).toBe(1);
    expect(gwLandCount(st, clientMsgId)).toBe(1);
  });
});
