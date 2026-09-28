import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
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
import { runJobOnce } from "../src/domain/jobs/engine.js";
import { reconcilerTick } from "../src/workers/unknownReconciler.js";
import { stepAgentRun } from "../src/domain/agent/engine.js";

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

async function emitEvent(type: string, data: Record<string, unknown>) {
  const res = await env.gatewayApp.inject({
    method: "POST",
    url: "/__admin/emit-event",
    payload: { type, data },
  });
  if (res.statusCode !== 200) throw new Error(`emit-event ${type}: ${res.body}`);
}

async function sendViaApi(groupId: string, accountId: string, text: string) {
  const res = await env.app.inject({
    method: "POST",
    url: `/api/groups/${groupId}/send`,
    headers: auth(token),
    payload: { accountId, text },
  });
  if (res.statusCode !== 202) throw new Error(`send: ${res.body}`);
  return (res.json() as { clientMsgId: string }).clientMsgId;
}

async function gwGroup(gatewayGroupId: string) {
  const res = await env.gatewayApp.inject({ method: "GET", url: "/__admin/state" });
  const state = res.json() as {
    groups: { id: string; promoteCalls: number; members: { platformUserId: string; role: string }[] }[];
  };
  return state.groups.find((g) => g.id === gatewayGroupId);
}

describe("R-INT: stale message_failed must not clobber terminal states", () => {
  it("message_failed after message_sent keeps status sent + surfaces inconsistency", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token, ["acc-2"]);
    const clientMsgId = await sendViaApi(groupId, "acc-2", "hello");
    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT delivery_status FROM messages WHERE client_msg_id=$1",
        [clientMsgId],
      );
      return rows[0]?.delivery_status === "sent";
    });

    // Gateway replays a failure for a message it already confirmed — stale.
    await emitEvent("message_failed", { clientMsgId, code: "GROUP_WRITE_FORBIDDEN" });

    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT 1 FROM ws_events WHERE type='inconsistency' AND payload->>'kind'='stale_failure'",
      );
      return rows.length > 0;
    });
    const { rows } = await env.pool.query(
      "SELECT delivery_status, msg_id FROM messages WHERE client_msg_id=$1",
      [clientMsgId],
    );
    expect(rows[0]!.delivery_status).toBe("sent");
    expect(rows[0]!.msg_id).toBeTruthy();
    // The failure's GROUP_WRITE_FORBIDDEN cascade must not have run either.
    const { rows: grp } = await env.pool.query("SELECT status FROM groups WHERE id=$1", [groupId]);
    expect(grp[0]!.status).toBe("active");
  });
});

describe("R-INT: member events for unknown groups are dead-lettered", () => {
  it("member_joined with an unknown gateway group lands in dead_events", async () => {
    workers = startWorkers(env.app.ctx);
    await seedGroup(env, token, ["acc-2"]); // consumer only needs to be running
    await emitEvent("member_joined", { groupId: "g-unknown", platformUserId: "pu-x" });
    await emitEvent("member_left", { groupId: "g-unknown", platformUserId: "pu-x" });

    await waitFor(async () => {
      const { rows } = await env.pool.query(
        "SELECT type, error FROM dead_events WHERE type IN ('member_joined','member_left')",
      );
      return rows.length === 2;
    });
    const { rows } = await env.pool.query(
      "SELECT count(*)::int AS n FROM ws_events WHERE type='inconsistency' AND payload->>'kind'='unknown_group'",
    );
    expect(rows[0]!.n).toBe(2);
  });
});

describe("R-AGENT: cancel must land while a step is stuck executing", () => {
  it("unresolvable executing step + cancel_requested -> run cancelled", async () => {
    const { groupId } = await seedGroup(env, token, ["acc-2"]);
    // Point the local group at a gateway group that does not exist so the
    // kick-member probe fails and resolveExecutingStep bails.
    await env.pool.query(
      "UPDATE groups SET gateway_group_id='g-gone', agent_enabled=true WHERE id=$1",
      [groupId],
    );
    const runId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO agent_runs (id, group_id, status, trigger_messages, cancel_requested)
       VALUES ($1,$2,'running','[]',true)`,
      [runId, groupId],
    );
    await env.pool.query(
      `INSERT INTO agent_steps (id, run_id, seq, kind, tool_use_id, name, input, state, audit_verdict)
       VALUES ($1,$2,1,'tool_use','tu-1','kick_user','{"platform_user_id":"pu-x"}','executing','pass')`,
      [crypto.randomUUID(), runId],
    );

    await stepAgentRun(env.app.ctx, runId);

    const { rows: run } = await env.pool.query(
      "SELECT status, end_reason FROM agent_runs WHERE id=$1",
      [runId],
    );
    expect(run[0]).toMatchObject({ status: "cancelled", end_reason: "cancelled" });
    const { rows: step } = await env.pool.query(
      "SELECT state, error_code FROM agent_steps WHERE run_id=$1 AND seq=1",
      [runId],
    );
    expect(step[0]).toMatchObject({ state: "done", error_code: "CANCELLED" });
  });
});

describe("R-JOB: promote call budget survives a crash", () => {
  it("promoteCalls persisted >= 2 means no third gateway call", async () => {
    const { groupId, gatewayGroupId } = await seedGroup(env, token, ["acc-2"]);
    const before = (await gwGroup(gatewayGroupId))!.promoteCalls;

    const jobId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO jobs (id, kind, group_id, status, state) VALUES ($1,'create_group',$2,'running',$3)`,
      [
        jobId,
        groupId,
        JSON.stringify({
          creatorAccountId: "acc-1",
          phase: "promote",
          gatewayGroupId,
          memberAccountIds: ["acc-2"],
          members: { "acc-2": { status: "joined" } },
          promoteCalls: 2,
        }),
      ],
    );

    await runJobOnce(env.app.ctx);

    const after = (await gwGroup(gatewayGroupId))!.promoteCalls;
    expect(after).toBe(before); // no extra call
    const { rows } = await env.pool.query("SELECT state FROM jobs WHERE id=$1", [jobId]);
    expect((rows[0]!.state as { phase: string }).phase).toBe("done");
    // The job records the unresolved outcome instead of silently succeeding.
    const { rows: errs } = await env.pool.query("SELECT errors FROM jobs WHERE id=$1", [jobId]);
    expect(JSON.stringify(errs[0]!.errors)).toContain("RESULT_UNKNOWN");
  });

  it("promoteCalls=1 allows exactly one more call", async () => {
    const { groupId, gatewayGroupId } = await seedGroup(env, token, ["acc-2"]);
    await env.pool.query(
      "INSERT INTO group_members (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-2','pu-acc-2','member') ON CONFLICT DO NOTHING",
      [groupId],
    );
    const before = (await gwGroup(gatewayGroupId))!.promoteCalls;

    const jobId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO jobs (id, kind, group_id, status, state) VALUES ($1,'create_group',$2,'running',$3)`,
      [
        jobId,
        groupId,
        JSON.stringify({
          creatorAccountId: "acc-1",
          phase: "promote",
          gatewayGroupId,
          memberAccountIds: ["acc-2"],
          members: { "acc-2": { status: "joined" } },
          promoteCalls: 1,
        }),
      ],
    );

    await runJobOnce(env.app.ctx);

    const g = await gwGroup(gatewayGroupId);
    expect(g!.promoteCalls).toBe(before + 1);
    expect(g!.members.find((m) => m.platformUserId === "pu-acc-2")?.role).toBe("admin");
  });
});

describe("R-AGENT: scheduling gaps count toward the 60s clock", () => {
  it("inter-claim gap is billed into elapsed_ms (downtime is not)", async () => {
    const { groupId } = await seedGroup(env, token, ["acc-2"]);
    await env.pool.query("UPDATE groups SET agent_enabled=true WHERE id=$1", [groupId]);
    // First turn is a non-ending tool call, then end_turn: keeps the run alive
    // across two claims so we can measure the real inter-claim gap.
    await env.agentApp.inject({
      method: "POST",
      url: "/__admin/script",
      payload: {
        runs: {
          "*": [
            { kind: "tool_use", name: "get_recent_messages", input: { limit: 3 } },
            { kind: "end_turn", text: "done" },
          ],
        },
      },
    });
    const runId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO agent_runs (id, group_id, status, trigger_messages)
       VALUES ($1,$2,'running','[]')`,
      [runId, groupId],
    );

    await stepAgentRun(env.app.ctx, runId); // claim 1: executes the tool step
    const { rows: mid } = await env.pool.query(
      "SELECT status, elapsed_ms FROM agent_runs WHERE id=$1",
      [runId],
    );
    expect(mid[0]!.status).toBe("running");
    const elapsedAfterStep1 = Number(mid[0]!.elapsed_ms);

    await new Promise((r) => setTimeout(r, 1600));
    await stepAgentRun(env.app.ctx, runId); // claim 2: gap should be billed

    const { rows } = await env.pool.query(
      "SELECT elapsed_ms FROM agent_runs WHERE id=$1",
      [runId],
    );
    const billed = Number(rows[0]!.elapsed_ms) - elapsedAfterStep1;
    expect(billed).toBeGreaterThanOrEqual(1400);
  });
});

describe("R-MSG: stale accepted messages reconcile via by-client-id", () => {
  it("accepted row whose message_sent was missed resolves to sent", async () => {
    const { groupId, gatewayGroupId } = await seedGroup(env, token, ["acc-2"]);
    const clientMsgId = crypto.randomUUID();
    // Land the message at the gateway directly (accepted + landed, but our
    // local row never saw the message_sent event).
    const send = await env.gatewayApp.inject({
      method: "POST",
      url: `/groups/${gatewayGroupId}/send`,
      payload: { accountId: "acc-2", clientMsgId, text: "hi" },
    });
    expect(send.statusCode).toBe(202);
    await waitFor(async () => {
      const res = await env.gatewayApp.inject({
        method: "GET",
        url: `/groups/${gatewayGroupId}/messages/by-client-id/${clientMsgId}`,
      });
      return res.statusCode === 200;
    });

    await env.pool.query(
      `INSERT INTO messages (group_id, client_msg_id, sender_account_id, is_own, text, sent_at, delivery_status, accepted_at)
       VALUES ($1,$2,'acc-2',true,'hi', now() - interval '30 seconds', 'accepted', now() - interval '30 seconds')`,
      [groupId, clientMsgId],
    );

    await reconcilerTick(env.app.ctx);

    const { rows } = await env.pool.query(
      "SELECT delivery_status, msg_id FROM messages WHERE client_msg_id=$1",
      [clientMsgId],
    );
    expect(rows[0]!.delivery_status).toBe("sent");
    expect(rows[0]!.msg_id).toBeTruthy();
  });

  it("accepted row the gateway never landed stays accepted (never resent)", async () => {
    const { groupId } = await seedGroup(env, token, ["acc-2"]);
    const clientMsgId = crypto.randomUUID();
    await env.pool.query(
      `INSERT INTO messages (group_id, client_msg_id, sender_account_id, is_own, text, sent_at, delivery_status, accepted_at)
       VALUES ($1,$2,'acc-2',true,'hi', now() - interval '30 seconds', 'accepted', now() - interval '30 seconds')`,
      [groupId, clientMsgId],
    );

    await reconcilerTick(env.app.ctx);
    await reconcilerTick(env.app.ctx);

    const { rows } = await env.pool.query(
      "SELECT delivery_status FROM messages WHERE client_msg_id=$1",
      [clientMsgId],
    );
    expect(rows[0]!.delivery_status).toBe("accepted");
  });
});

describe("R-API: creating groups stay out of the public enum", () => {
  it("GET /api/groups omits creating; GET /:id returns 404 until active", async () => {
    const { groupId } = await seedGroup(env, token, ["acc-2"]); // active
    const creatingId = crypto.randomUUID();
    await env.pool.query(
      "INSERT INTO groups (id, status, creator_account_id) VALUES ($1,'creating','acc-1')",
      [creatingId],
    );

    const list = await env.app.inject({
      method: "GET",
      url: "/api/groups",
      headers: auth(token),
    });
    const ids = (list.json() as { id: string }[]).map((g) => g.id);
    expect(ids).toContain(groupId);
    expect(ids).not.toContain(creatingId);

    const detail = await env.app.inject({
      method: "GET",
      url: `/api/groups/${creatingId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(404);
  });
});
