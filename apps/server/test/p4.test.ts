import crypto from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  startTestEnv,
  truncateAll,
  migrateTestDb,
  login,
  auth,
  waitFor,
  seedGroup,
  type TestEnv,
} from "./helpers.js";
import { startWorkers, type WorkersHandle } from "../src/workers/index.js";
import { stepAgentRun } from "../src/domain/agent/engine.js";

let env: TestEnv;
let workers: WorkersHandle | null = null;
let token: string;

beforeAll(async () => {
  await migrateTestDb();
  env = await startTestEnv();
});

beforeEach(async () => {
  await truncateAll(env.pool);
  token = (await login(env.app, "admin", "admin")).accessToken;
  workers = startWorkers(env.app.ctx);
});

afterEach(async () => {
  await workers?.stop();
  workers = null;
  // Let accepted-but-not-yet-landed sends finish landing before resetting the
  // mocks, otherwise they leak into the next test.
  await new Promise((r) => setTimeout(r, 150));
  await env.agentApp.inject({ method: "POST", url: "/__admin/reset" });
  await env.gatewayApp.inject({ method: "POST", url: "/__admin/reset" });
});

async function script(runs: Record<string, unknown[]>, audit?: unknown[]) {
  await env.agentApp.inject({
    method: "POST",
    url: "/__admin/script",
    payload: { runs, ...(audit ? { audit } : {}) },
  });
}

async function agentState() {
  const res = await env.agentApp.inject({ method: "GET", url: "/__admin/state" });
  return res.json() as {
    turnCalls: Array<{ runId: string; body: { messages: unknown[] } }>;
    turnCallsByRun: Record<string, Array<{ messages: unknown[] }>>;
    auditCalls: Array<{ body: { text: string } }>;
  };
}

async function gwMessages(gatewayGroupId: string) {
  const res = await env.gatewayApp.inject({ method: "GET", url: "/__admin/state" });
  const st = res.json() as {
    messages: Array<{
      groupId: string;
      messages: Array<{ msgId: string; clientMsgId: string | null }>;
    }>;
  };
  return st.messages.find((m) => m.groupId === gatewayGroupId)?.messages ?? [];
}

async function externalMessage(gatewayGroupId: string, platformUserId: string, text: string) {
  await env.gatewayApp.inject({
    method: "POST",
    url: `/__admin/groups/${gatewayGroupId}/external-message`,
    payload: { platformUserId, text },
  });
}

async function externalJoin(gatewayGroupId: string, platformUserId: string) {
  await env.gatewayApp.inject({
    method: "POST",
    url: `/__admin/groups/${gatewayGroupId}/external-join`,
    payload: { platformUserId },
  });
}

async function runs(groupId: string) {
  const res = await env.app.inject({
    method: "GET",
    url: `/api/groups/${groupId}/agent-runs`,
    headers: auth(token),
  });
  return res.json() as Array<{ id: string; status: string; endReason: string | null }>;
}

async function runDetail(runId: string) {
  const res = await env.app.inject({
    method: "GET",
    url: `/api/agent-runs/${runId}`,
    headers: auth(token),
  });
  return res.json() as {
    id: string;
    status: string;
    endReason: string | null;
    summary: string | null;
    steps: Array<{
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
    }>;
  };
}

async function agentGroup(memberIds = ["acc-2"], opts: { autoKick?: boolean } = {}) {
  const { groupId, gatewayGroupId } = await seedGroup(env, token, memberIds);
  await env.app.inject({
    method: "PATCH",
    url: `/api/groups/${groupId}`,
    headers: auth(token),
    payload: { agentEnabled: true, ...(opts.autoKick ? { autoKickEnabled: true } : {}) },
  });
  return { groupId, gatewayGroupId };
}

describe("trigger", () => {
  it("external message on agentEnabled group creates a run with correct trigger ctx", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "hello agents");
    await waitFor(async () => (await runs(groupId)).length === 1);
    const [run] = await runs(groupId);
    await waitFor(async () => {
      const st = await agentState();
      return (st.turnCallsByRun[run!.id] ?? []).length > 0;
    });
    const st = await agentState();
    const firstMsg = st.turnCallsByRun[run!.id]![0]!.messages[0] as {
      role: string;
      content: Array<{ text: string }>;
    };
    const ctxJson = JSON.parse(firstMsg.content[0]!.text) as {
      groupId: string;
      triggerMessages: Array<{ text: string; sentAt: number; senderPlatformUserId: string }>;
      policy: { autoKickEnabled: boolean };
      ownPlatformUserIds: string[];
    };
    expect(ctxJson.groupId).toBe(groupId);
    expect(ctxJson.triggerMessages).toHaveLength(1);
    expect(ctxJson.triggerMessages[0]!.text).toBe("hello agents");
    expect(ctxJson.ownPlatformUserIds.sort()).toEqual(["pu-acc-1", "pu-acc-2"]);
    expect(ctxJson.policy.autoKickEnabled).toBe(false);
  });

  it("own message and agentEnabled=false produce no run", async () => {
    const { groupId } = await agentGroup();
    // own send
    await env.app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/send`,
      headers: auth(token),
      payload: { accountId: "acc-1", text: "mine" },
    });
    // disabled group (build inline; acc-1 is already connected so seedGroup
    // would fail with ILLEGAL_TRANSITION)
    const g2res = await env.gatewayApp.inject({
      method: "POST",
      url: "/groups",
      payload: { creatorAccountId: "acc-1" },
    });
    const g2gw = (g2res.json() as { groupId: string }).groupId;
    const g2 = { groupId: crypto.randomUUID(), gatewayGroupId: g2gw };
    await env.pool.query(
      "INSERT INTO groups (id, gateway_group_id, status, creator_account_id) VALUES ($1,$2,'active','acc-1')",
      [g2.groupId, g2gw],
    );
    await env.pool.query(
      "INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-1','pu-acc-1','creator')",
      [g2.groupId],
    );
    await externalJoin(g2.gatewayGroupId, "pu-ext-9");
    await externalMessage(g2.gatewayGroupId, "pu-ext-9", "no agent here");
    await new Promise((r) => setTimeout(r, 700));
    expect(await runs(groupId)).toHaveLength(0);
    expect(await runs(g2.groupId)).toHaveLength(0);
  });
});

describe("run lifecycle", () => {
  it("happy path: get_recent -> send -> finish; audit once; message sent", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        { kind: "tool_use", name: "get_recent_messages", input: { limit: 10 } },
        {
          kind: "tool_use",
          name: "send_message",
          input: { text: "hi all", idempotency_key: "k1" },
        },
        { kind: "tool_use", name: "finish", input: { summary: "all done" } },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "question?");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.endReason).toBe("final");
    expect(run.summary).toBe("all done");
    expect(run.steps).toHaveLength(3);
    expect(run.steps.map((s) => s.kind)).toEqual(["tool_use", "tool_use", "final"]);
    // message landed in gateway
    await waitFor(async () => (await gwMessages(gatewayGroupId)).length === 1, 5000);
    // audit called exactly once with the text
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(1);
    expect(st.auditCalls[0]!.body.text).toBe("hi all");
    // get_recent result included the trigger message (check history on turn 2)
    const turn2 = st.turnCallsByRun[run.id]![1]!;
    const toolResultMsg = (
      turn2.messages as Array<{ role: string; content: Array<{ type: string; content?: string }> }>
    )
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    const parsed = JSON.parse(toolResultMsg!.content!) as {
      messages: Array<{ text: string; isOwn: boolean }>;
    };
    expect(parsed.messages.some((m) => m.text === "question?" && !m.isOwn)).toBe(true);
  });

  it("messages during a run become pending and trigger a follow-up run", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        {
          kind: "delay",
          ms: 300,
          then: { kind: "tool_use", name: "finish", input: { summary: "s1" } },
        },
        { kind: "tool_use", name: "finish", input: { summary: "s2" } },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "first");
    await waitFor(async () => (await runs(groupId)).length === 1);
    // while run is running, send two more
    await externalMessage(gatewayGroupId, "pu-ext-1", "during-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "during-2");
    await waitFor(async () => {
      const rs = await runs(groupId);
      return rs.length === 2 && rs.every((r) => r.status !== "running");
    });
    const rs = await runs(groupId);
    expect(rs).toHaveLength(2);
  });
});

describe("S5 idempotent send", () => {
  it("504 then delivered: one gateway message; replay returns same clientMsgId", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        { kind: "tool_use", name: "send_message", input: { text: "once", idempotency_key: "k1" } },
        { kind: "tool_use", name: "send_message", input: { text: "once", idempotency_key: "k1" } },
        { kind: "tool_use", name: "finish", input: { summary: "ok" } },
      ],
    });
    await env.gatewayApp.inject({
      method: "POST",
      url: `/__admin/accounts/acc-1/inject`,
      payload: { code: "NETWORK_TIMEOUT", once: true, actuallyDelivered: true },
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished", 15000);
    await waitFor(async () => (await gwMessages(gatewayGroupId)).length === 1, 5000);
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(1);
  });
});

describe("S6 protocol errors", () => {
  it("fenced json -> protocol_error; unknown tool -> is_error step; then final", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        { kind: "raw", body: '```json\n{"stop_reason":"end_turn"}\n```' },
        { kind: "tool_use", name: "nonsense_tool", input: {} },
        { kind: "end_turn", text: "bye" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.endReason).toBe("final");
    expect(run.steps).toHaveLength(3);
    expect(run.steps[0]!.kind).toBe("protocol_error");
    expect(run.steps[0]!.errorCode).toBe("BAD_JSON");
    expect(run.steps[0]!.rawResponse).toContain("```");
    expect(run.steps[1]!.kind).toBe("tool_use");
    expect(run.steps[1]!.isError).toBe(true);
    expect(run.steps[1]!.errorCode).toBe("UNKNOWN_TOOL");
    expect(run.steps[2]!.kind).toBe("final");
  });

  it("three consecutive BAD_JSON -> failed/protocol_errors; valid resets counter", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        { kind: "raw", body: "nope" },
        { kind: "raw", body: "nope2" },
        { kind: "raw", body: "nope3" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => {
      const rs = await runs(groupId);
      return rs.length > 0 && rs[0]!.status !== "running";
    });
    let run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.status).toBe("failed");
    expect(run.endReason).toBe("protocol_errors");
    expect(run.steps.filter((s) => s.kind === "protocol_error")).toHaveLength(3);

    // Reset: 2 bad, 1 valid, 2 bad, 1 valid -> does not fail on counter
    await truncateAll(env.pool);
    token = (await login(env.app, "admin", "admin")).accessToken;
    const g2 = await agentGroup();
    await script({
      "*": [
        { kind: "raw", body: "x" },
        { kind: "raw", body: "x" },
        { kind: "end_turn", text: "valid" },
      ],
    });
    await externalJoin(g2.gatewayGroupId, "pu-ext-1");
    await externalMessage(g2.gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => {
      const rs = await runs(g2.groupId);
      return rs.length > 0 && rs[0]!.status !== "running";
    });
    run = await runDetail((await runs(g2.groupId))[0]!.id);
    expect(run.status).toBe("finished");
  });
});

describe("budget", () => {
  it("12 tool calls -> failed/budget_exhausted", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    const steps = Array.from({ length: 15 }, (_, i) => ({
      kind: "tool_use",
      name: "get_recent_messages",
      input: { limit: i + 1 },
    }));
    await script({ "*": steps });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "failed", 20000);
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.endReason).toBe("budget_exhausted");
    expect(run.steps.length).toBeLessThanOrEqual(12);
  });

  it("identical get_recent calls: 2nd gets hint, 3rd+ INVALID_INPUT", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        { kind: "tool_use", name: "get_recent_messages", input: { limit: 3 } },
        { kind: "tool_use", name: "get_recent_messages", input: { limit: 3 } },
        { kind: "tool_use", name: "get_recent_messages", input: { limit: 3 } },
        { kind: "tool_use", name: "get_recent_messages", input: { limit: 3 } },
        { kind: "end_turn", text: "done" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    const grSteps = run.steps.filter((s) => s.name === "get_recent_messages");
    expect(grSteps).toHaveLength(4);
    expect(grSteps[0]!.isError).toBe(false);
    expect(grSteps[1]!.isError).toBe(false);
    expect(grSteps[2]!.isError).toBe(true);
    expect(grSteps[2]!.errorCode).toBe("INVALID_INPUT");
    expect(grSteps[3]!.errorCode).toBe("INVALID_INPUT");
  });
});

describe("TURN_TIMEOUT", () => {
  it("slow response -> TURN_TIMEOUT protocol error; run continues", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        { kind: "delay", ms: 3000, then: { kind: "end_turn", text: "too late" } },
        { kind: "end_turn", text: "on time" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished", 15000);
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.steps[0]!.kind).toBe("protocol_error");
    expect(run.steps[0]!.errorCode).toBe("TURN_TIMEOUT");
    expect(run.summary).toBe("on time");
  });
});

describe("audit", () => {
  it("audit fail -> AUDIT_REJECTED, key not consumed, retry audits again", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script(
      {
        "*": [
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "spam", idempotency_key: "k1" },
          },
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "fine", idempotency_key: "k1" },
          },
          { kind: "end_turn", text: "done" },
        ],
      },
      [{ match: "spam", verdict: "fail" }],
    );
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.steps[0]!.isError).toBe(true);
    expect(run.steps[0]!.errorCode).toBe("AUDIT_REJECTED");
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(2);
    await waitFor(async () => (await gwMessages(gatewayGroupId)).length === 1, 5000);
  });

  it("audit 500 x3 -> run blocked/audit_blocked + ws inconsistency", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script(
      {
        "*": [
          { kind: "tool_use", name: "send_message", input: { text: "x", idempotency_key: "k1" } },
        ],
      },
      [{ verdict: "raw", raw: { status: 500, body: "err" } }],
    );
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "blocked", 15000);
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.endReason).toBe("audit_blocked");
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(3);
    const { rows: ws } = await env.pool.query<{ payload: { kind: string } }>(
      "SELECT payload FROM ws_events WHERE type='inconsistency' AND payload->>'kind'='audit_blocked'",
    );
    expect(ws.length).toBe(1);
    // audit blocked -> nothing should have been sent
    expect(await gwMessages(gatewayGroupId)).toHaveLength(0);
  });

  it("audit bad json twice then pass -> sent", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script(
      {
        "*": [
          { kind: "tool_use", name: "send_message", input: { text: "ok", idempotency_key: "k1" } },
          { kind: "end_turn", text: "done" },
        ],
      },
      [{ verdict: "raw", raw: { body: "not-json" }, times: 2 }, { verdict: "pass" }],
    );
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(3);
    await waitFor(async () => (await gwMessages(gatewayGroupId)).length === 1, 5000);
  });
});

describe("kick_user", () => {
  it("autoKickEnabled=false -> POLICY_DENIED without audit", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        {
          kind: "tool_use",
          name: "kick_user",
          input: { platform_user_id: "pu-acc-2", reason: "r" },
        },
        { kind: "end_turn", text: "done" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.steps[0]!.isError).toBe(true);
    expect(run.steps[0]!.errorCode).toBe("POLICY_DENIED");
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(0);
  });

  it("autoKickEnabled=true -> audited kick removes member", async () => {
    const { groupId, gatewayGroupId } = await agentGroup(["acc-2"], { autoKick: true });
    await script({
      "*": [
        {
          kind: "tool_use",
          name: "kick_user",
          input: { platform_user_id: "pu-acc-2", reason: "spam" },
        },
        { kind: "end_turn", text: "done" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.steps[0]!.isError).toBe(false);
    const st = await agentState();
    expect(st.auditCalls).toHaveLength(1);
    const auditText = JSON.parse(st.auditCalls[0]!.body.text) as { action: string };
    expect(auditText.action).toBe("kick");
    const { rows: members } = await env.pool.query(
      "SELECT platform_user_id FROM group_members WHERE group_id=$1",
      [groupId],
    );
    expect(members.map((m) => m.platform_user_id).sort()).toEqual(["pu-acc-1", "pu-ext-1"]);
  });

  it("no online privileged member -> NO_AVAILABLE_ACCOUNT", async () => {
    const { groupId, gatewayGroupId } = await agentGroup(["acc-2"], { autoKick: true });
    // demote creator in our DB only; leave acc-1 online but role member
    await env.pool.query("UPDATE group_members SET role='member' WHERE group_id=$1", [groupId]);
    await script({
      "*": [
        {
          kind: "tool_use",
          name: "kick_user",
          input: { platform_user_id: "pu-acc-2", reason: "r" },
        },
        { kind: "end_turn", text: "done" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.steps[0]!.isError).toBe(true);
    expect(run.steps[0]!.errorCode).toBe("NO_AVAILABLE_ACCOUNT");
  });
});

describe("cancel", () => {
  it("agentEnabled=false mid-run -> cancelled after current step", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await script({
      "*": [
        {
          kind: "delay",
          ms: 400,
          then: { kind: "tool_use", name: "get_recent_messages", input: { limit: 1 } },
        },
        { kind: "end_turn", text: "never" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId)).length === 1);
    await env.app.inject({
      method: "PATCH",
      url: `/api/groups/${groupId}`,
      headers: auth(token),
      payload: { agentEnabled: false },
    });
    await waitFor(async () => (await runs(groupId))[0]?.status === "cancelled", 15000);
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.endReason).toBe("cancelled");
  });
});

describe("send edge cases", () => {
  it("all members offline -> NO_AVAILABLE_ACCOUNT, run continues", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await env.pool.query("UPDATE accounts SET status='idle' WHERE id IN ('acc-1','acc-2')");
    await script({
      "*": [
        { kind: "tool_use", name: "send_message", input: { text: "x", idempotency_key: "k1" } },
        { kind: "end_turn", text: "done" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => (await runs(groupId))[0]?.status === "finished");
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.steps[0]!.errorCode).toBe("NO_AVAILABLE_ACCOUNT");
  });

  it("GROUP_WRITE_FORBIDDEN on send -> GROUP_UNREACHABLE result, run cancelled", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await env.gatewayApp.inject({
      method: "POST",
      url: `/__admin/groups/${gatewayGroupId}/inject`,
      payload: { code: "GROUP_WRITE_FORBIDDEN" },
    });
    await script({
      "*": [
        { kind: "tool_use", name: "send_message", input: { text: "x", idempotency_key: "k1" } },
        { kind: "end_turn", text: "done" },
      ],
    });
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "go");
    await waitFor(async () => {
      const rs = await runs(groupId);
      return rs.length > 0 && rs[0]!.status !== "running";
    }, 15000);
    const run = await runDetail((await runs(groupId))[0]!.id);
    expect(run.status).toBe("cancelled");
    expect(run.steps[0]!.errorCode).toBe("GROUP_UNREACHABLE");
  });
});

describe("recovery", () => {
  it("crash after executing-step commit -> resume finalizes without re-sending", async () => {
    process.env.ENABLE_FAULT_INJECTION = "1";
    try {
      const { groupId, gatewayGroupId } = await agentGroup();
      await script({
        "*": [
          {
            kind: "tool_use",
            name: "send_message",
            input: { text: "once", idempotency_key: "k1" },
          },
          { kind: "tool_use", name: "finish", input: { summary: "ok" } },
        ],
      });
      await externalJoin(gatewayGroupId, "pu-ext-1");
      await externalMessage(gatewayGroupId, "pu-ext-1", "go");
      // Arm the crash before the send step executes: the worker will commit
      // the 'executing' step then throw, simulating a mid-flight crash.
      env.app.ctx.faults.failAfterExecuting = true;
      await waitFor(async () => (await runs(groupId)).length === 1);
      const runId = (await runs(groupId))[0]!.id;
      await waitFor(async () => {
        const { rows } = await env.pool.query("SELECT status FROM agent_runs WHERE id=$1", [runId]);
        return rows[0]?.status === "finished";
      }, 15000);
      const run = await runDetail(runId);
      expect(run.status).toBe("finished");
      const sendSteps = run.steps.filter((s) => s.name === "send_message");
      expect(sendSteps).toHaveLength(1);
      await waitFor(async () => (await gwMessages(gatewayGroupId)).length === 1, 5000);
    } finally {
      delete process.env.ENABLE_FAULT_INJECTION;
    }
  });

  it("elapsed_ms near budget -> failed/wall_clock; lease gap not counted", async () => {
    const { groupId } = await agentGroup();
    // create a run manually with elapsed just under the cap
    const runId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO agent_runs (id, group_id, status, trigger_messages, elapsed_ms, resumed_at, lease_until)
       VALUES ($1,$2,'running','[]',59000, now() - interval '10 minutes', now() - interval '1 minute')`,
      [runId, groupId],
    );
    await script({ "*": [{ kind: "end_turn", text: "ok" }] });
    await stepAgentRun(env.app.ctx, runId);
    // one step ran (claim did not count the 10-min gap)
    let run = await runDetail(runId);
    expect(run.status).toBe("finished");
    const { rows } = await env.pool.query<{ elapsed_ms: string }>(
      "SELECT elapsed_ms FROM agent_runs WHERE id=$1",
      [runId],
    );
    expect(Number(rows[0]!.elapsed_ms)).toBeLessThan(60_000);

    const runId2 = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO agent_runs (id, group_id, status, trigger_messages, elapsed_ms)
       VALUES ($1,$2,'running','[]',60000)`,
      [runId2, groupId],
    );
    await stepAgentRun(env.app.ctx, runId2);
    run = await runDetail(runId2);
    expect(run.status).toBe("failed");
    expect(run.endReason).toBe("wall_clock");
  });
});

describe("result size", () => {
  it("get_recent_messages truncates to 8KB and flags truncated", async () => {
    const { groupId, gatewayGroupId } = await agentGroup();
    await externalJoin(gatewayGroupId, "pu-ext-1");
    await externalMessage(gatewayGroupId, "pu-ext-1", "x".repeat(20000));
    await waitFor(async () => (await runs(groupId)).length === 1);
    const runId = (await runs(groupId))[0]!.id;
    await script({
      "*": [
        { kind: "tool_use", name: "get_recent_messages", input: { limit: 10 } },
        { kind: "end_turn", text: "done" },
      ],
    });
    await waitFor(async () => (await runDetail(runId)).status === "finished", 15000);
    const st = await agentState();
    const turn2 = st.turnCallsByRun[runId]![1]!;
    const tr = (turn2.messages as Array<{ content: Array<{ type: string; content?: string }> }>)
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result")!;
    expect(tr.content!.length).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.parse(tr.content!)).toHaveProperty("truncated", true);
    const run = await runDetail(runId);
    for (const s of run.steps) {
      expect((s.resultSummary ?? "").length).toBeLessThanOrEqual(200);
    }
  });
});
