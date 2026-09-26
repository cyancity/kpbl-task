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
import { startSequenceWorker } from "../src/workers/sequences.js";

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
});

afterEach(async () => {
  await workers?.stop();
  workers = null;
  await new Promise((r) => setTimeout(r, 150));
  await env.agentApp.inject({ method: "POST", url: "/__admin/reset" });
  await env.gatewayApp.inject({ method: "POST", url: "/__admin/reset" });
});

async function createSequence(
  steps: Array<{ index: number; accountRole: "admin" | "member"; text: string; delaySeconds: number }>,
  name = "seq",
) {
  const res = await env.app.inject({
    method: "POST",
    url: "/api/sequences",
    headers: auth(token),
    payload: { name, steps },
  });
  return { status: res.statusCode, body: res.json() as { id?: string; error?: { code: string } } };
}

async function startRun(
  groupId: string,
  sequenceId: string,
  vars?: Record<string, string>,
  stepVars?: Record<string, Record<string, string>>,
) {
  const res = await env.app.inject({
    method: "POST",
    url: `/api/groups/${groupId}/sequence-runs`,
    headers: auth(token),
    payload: { sequenceId, vars, stepVars },
  });
  return {
    status: res.statusCode,
    body: res.json() as { runId?: string; error?: { code: string; stepIndex?: number; key?: string } },
  };
}

async function runDetail(runId: string) {
  const res = await env.app.inject({
    method: "GET",
    url: `/api/sequence-runs/${runId}`,
    headers: auth(token),
  });
  return res.json() as {
    id: string;
    status: string;
    currentStepIndex: number | null;
    steps: Array<{
      index: number;
      status: string;
      scheduledAt: string | null;
      sentAt: string | null;
      clientMsgId: string | null;
      resolvedVars: Record<string, string>;
      varSources: Record<string, string>;
      accountId: string | null;
    }>;
  };
}

async function gwMessages(gatewayGroupId: string) {
  const res = await env.gatewayApp.inject({ method: "GET", url: "/__admin/state" });
  const st = res.json() as {
    messages: Array<{ groupId: string; messages: Array<{ msgId: string; clientMsgId: string | null }> }>;
    accounts: Array<{ id: string; sendCalls: number }>;
  };
  return st.messages.find((m) => m.groupId === gatewayGroupId)?.messages ?? [];
}

describe("sequence routes", () => {
  it("create/list/get; validation rejects non-contiguous and dup indexes", async () => {
    const bad = await createSequence([
      { index: 1, accountRole: "admin", text: "a", delaySeconds: 0 },
      { index: 1, accountRole: "member", text: "b", delaySeconds: 0 },
    ]);
    expect(bad.status).toBe(400);
    const gap = await createSequence([
      { index: 1, accountRole: "admin", text: "a", delaySeconds: 0 },
      { index: 3, accountRole: "member", text: "b", delaySeconds: 0 },
    ]);
    expect(gap.status).toBe(400);
    const ok = await createSequence([
      { index: 1, accountRole: "admin", text: "a", delaySeconds: 0 },
      { index: 2, accountRole: "member", text: "b", delaySeconds: 0 },
    ]);
    expect(ok.status).toBe(201);
    const list = await env.app.inject({
      method: "GET",
      url: "/api/sequences",
      headers: auth(token),
    });
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it("resolve endpoint previews without creating anything", async () => {
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "{event} at {location}", delaySeconds: 0 },
    ]);
    const res = await env.app.inject({
      method: "POST",
      url: `/api/sequences/${seq.body.id}/resolve`,
      headers: auth(token),
      payload: { vars: { event: "launch" }, stepVars: { "1": { location: "hall" } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { steps: Array<{ text: string; varSources: Record<string, string> }> };
    expect(body.steps[0]!.text).toBe("launch at hall");
    expect(body.steps[0]!.varSources).toEqual({ event: "default", location: "step:1" });
  });
});

describe("S8 precheck", () => {
  it("unresolved placeholder -> 422 with stepIndex+key, no rows, no sends", async () => {
    const { groupId } = await seedGroup(env, token);
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "one", delaySeconds: 0 },
      { index: 2, accountRole: "member", text: "two", delaySeconds: 0 },
      { index: 3, accountRole: "member", text: "files at {location}", delaySeconds: 0 },
    ]);
    const res = await startRun(groupId, seq.body.id!, { event: "x" });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("UNRESOLVED_PLACEHOLDER");
    expect(res.body.error?.stepIndex).toBe(3);
    expect(res.body.error?.key).toBe("location");
    const { rows } = await env.pool.query("SELECT count(*)::int c FROM sequence_runs");
    expect(rows[0]!.c).toBe(0);
    const st = await env.gatewayApp.inject({ method: "GET", url: "/__admin/state" });
    expect((st.json() as { accounts: Array<{ sendCalls: number }> }).accounts[0]!.sendCalls).toBe(0);
    // providing it -> 201
    const ok = await startRun(groupId, seq.body.id!, {}, { "3": { location: "share" } });
    expect(ok.status).toBe(201);
  });
});

describe("S7 concurrency", () => {
  it("two starts -> one 201, one 409; second run allowed after finish", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token);
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "s1", delaySeconds: 0.05 },
    ]);
    const [a, b] = await Promise.all([
      startRun(groupId, seq.body.id!),
      startRun(groupId, seq.body.id!),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);
    expect([a.body.error?.code, b.body.error?.code]).toContain("SEQUENCE_ALREADY_RUNNING");
    const runId = (a.body.runId ?? b.body.runId)!;
    await waitFor(async () => (await runDetail(runId)).status !== "running", 15000);
    const again = await startRun(groupId, seq.body.id!);
    expect(again.status).toBe(201);
  });
});

describe("scheduler", () => {
  it("timing + roles: delays honored, anchored on previous sent_at", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token, ["acc-2", "acc-3"]);
    // promote acc-2 to admin in our DB (role preference check)
    await env.pool.query(
      "UPDATE group_members SET role='admin' WHERE group_id=$1 AND account_id='acc-2'",
      [groupId],
    );
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "hello {event}", delaySeconds: 0.3 },
      { index: 2, accountRole: "member", text: "remind {event}", delaySeconds: 0.5 },
    ]);
    const started = Date.now();
    const { body } = await startRun(groupId, seq.body.id!, { event: "E1" });
    const runId = body.runId!;
    await waitFor(async () => (await runDetail(runId)).status === "finished", 15000);
    const run = await runDetail(runId);
    const [s1, s2] = run.steps;
    expect(s1!.status).toBe("sent");
    expect(s2!.status).toBe("sent");
    // step1 sent ≈ start + 300ms
    const t1 = new Date(s1!.sentAt!).getTime();
    expect(t1 - started).toBeGreaterThanOrEqual(250);
    expect(t1 - started).toBeLessThan(2500);
    // step2 scheduled_at ≈ step1.sent_at + 500ms
    const sched2 = new Date(s2!.scheduledAt!).getTime();
    expect(Math.abs(sched2 - (t1 + 500))).toBeLessThan(150);
    // roles: admin step used acc-2 (admin over creator), member step used acc-3 (lexicographic)
    expect(s1!.accountId).toBe("acc-2");
    expect(s2!.accountId).toBe("acc-3");
    // texts substituted in gateway messages
    const msgs = await gwMessages(gatewayGroupId);
    expect(msgs).toHaveLength(2);
  });

  it("no online member -> member step skipped with sent_at; next step chains from skip", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token, []); // only creator acc-1
    const seq = await createSequence([
      { index: 1, accountRole: "member", text: "skip me", delaySeconds: 0 },
      { index: 2, accountRole: "admin", text: "after", delaySeconds: 0.2 },
    ]);
    const { body } = await startRun(groupId, seq.body.id!);
    const runId = body.runId!;
    await waitFor(async () => (await runDetail(runId)).status === "finished", 15000);
    const run = await runDetail(runId);
    expect(run.steps[0]!.status).toBe("skipped");
    expect(run.steps[0]!.sentAt).not.toBeNull();
    expect(run.steps[1]!.status).toBe("sent");
    // step2 scheduled ≈ step1 skip time + 200ms
    const skipAt = new Date(run.steps[0]!.sentAt!).getTime();
    const sched2 = new Date(run.steps[1]!.scheduledAt!).getTime();
    expect(Math.abs(sched2 - (skipAt + 200))).toBeLessThan(150);
  });

  it("rate_limited member-only candidate defers the step, never skips", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token, ["acc-2"]);
    // step target: member acc-2. Put acc-2 into rate_limited.
    await env.pool.query(
      "UPDATE accounts SET status='rate_limited', rate_limited_until=now()+interval '1 second' WHERE id='acc-2'",
    );
    const seq = await createSequence([
      { index: 1, accountRole: "member", text: "wait for me", delaySeconds: 0 },
    ]);
    const { body } = await startRun(groupId, seq.body.id!);
    const runId = body.runId!;
    // during the window, step stays pending
    await new Promise((r) => setTimeout(r, 500));
    let run = await runDetail(runId);
    expect(run.steps[0]!.status === "pending" || run.steps[0]!.status === "accepted").toBe(true);
    await waitFor(async () => (await runDetail(runId)).status === "finished", 15000);
    run = await runDetail(runId);
    expect(run.steps[0]!.status).toBe("sent");
    expect(run.steps[0]!.accountId).toBe("acc-2");
  });

  it("429 on send holds the queued message until rate-limit expiry (defer, not skip)", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token, ["acc-2"]);
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-1/inject",
      payload: { code: "RATE_LIMITED", retryAfterSeconds: 1, once: true },
    });
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "s1", delaySeconds: 0 },
      { index: 2, accountRole: "member", text: "s2", delaySeconds: 0.2 },
    ]);
    const { body } = await startRun(groupId, seq.body.id!);
    const runId = body.runId!;
    await waitFor(async () => (await runDetail(runId)).status === "finished", 15000);
    const run = await runDetail(runId);
    expect(run.steps.map((s) => s.status)).toEqual(["sent", "sent"]);
  });

  it("account going terminal mid-run -> step skipped via cascade, run continues", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId } = await seedGroup(env, token, ["acc-2"]);
    // hold acc-1's send via one-shot RATE_LIMITED injection, then suspend acc-1
    await env.gatewayApp.inject({
      method: "POST",
      url: "/__admin/accounts/acc-1/inject",
      payload: { code: "RATE_LIMITED", retryAfterSeconds: 30, once: true },
    });
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "doomed", delaySeconds: 0 },
      { index: 2, accountRole: "member", text: "survives", delaySeconds: 0.1 },
    ]);
    const { body } = await startRun(groupId, seq.body.id!);
    const runId = body.runId!;
    // wait until step1's message is queued and acc-1 got rate_limited, then suspend
    await waitFor(async () => {
      const r = await runDetail(runId);
      const { rows } = await env.pool.query(
        "SELECT status FROM accounts WHERE id='acc-1'",
      );
      return r.steps[0]!.status === "accepted" && rows[0]!.status === "rate_limited";
    });
    const tr = await env.app.inject({
      method: "POST",
      url: "/api/accounts/acc-1/transition",
      headers: auth(token),
      payload: { to: "suspended", expectedFrom: "rate_limited" },
    });
    expect(tr.statusCode).toBe(200);
    await waitFor(async () => (await runDetail(runId)).status === "finished", 15000);
    const run = await runDetail(runId);
    expect(run.steps[0]!.status).toBe("skipped");
    expect(run.steps[1]!.status).toBe("sent");
  });

  it("GROUP_WRITE_FORBIDDEN on step1 -> run stopped, group unreachable", async () => {
    workers = startWorkers(env.app.ctx);
    const { groupId, gatewayGroupId } = await seedGroup(env, token);
    await env.gatewayApp.inject({
      method: "POST",
      url: `/__admin/groups/${gatewayGroupId}/inject`,
      payload: { code: "GROUP_WRITE_FORBIDDEN" },
    });
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "s1", delaySeconds: 0 },
      { index: 2, accountRole: "member", text: "s2", delaySeconds: 0.1 },
    ]);
    const { body } = await startRun(groupId, seq.body.id!);
    const runId = body.runId!;
    await waitFor(async () => (await runDetail(runId)).status === "stopped", 15000);
    const run = await runDetail(runId);
    expect(run.steps[0]!.status === "failed" || run.steps[0]!.status === "accepted").toBe(true);
    expect(run.steps[1]!.status).toBe("pending");
    const { rows } = await env.pool.query("SELECT status FROM groups WHERE id=$1", [groupId]);
    expect(rows[0]!.status).toBe("unreachable");
    const { rows: ws } = await env.pool.query(
      "SELECT 1 FROM ws_events WHERE type='sequence_run' AND payload->>'status'='stopped'",
    );
    expect(ws.length).toBeGreaterThan(0);
  });

  it("restart: overdue pending step is rescheduled by its own delay, not fired immediately", async () => {
    const { groupId } = await seedGroup(env, token);
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "s1", delaySeconds: 0 },
      { index: 2, accountRole: "admin", text: "s2", delaySeconds: 5 },
      { index: 3, accountRole: "admin", text: "s3", delaySeconds: 0.1 },
    ]);
    const { body } = await startRun(groupId, seq.body.id!);
    const runId = body.runId!;
    // Simulate a run that lost step 1 to history and sat idle past step 2's slot.
    await env.pool.query(
      "UPDATE sequence_run_steps SET status='sent', sent_at=now() - interval '5 seconds' WHERE run_id=$1 AND index=1",
      [runId],
    );
    await env.pool.query(
      "UPDATE sequence_run_steps SET scheduled_at=now() - interval '3 seconds' WHERE run_id=$1 AND index=2",
      [runId],
    );
    await env.pool.query(
      "UPDATE sequence_runs SET current_step_index=2, last_tick_at=now() - interval '10 seconds' WHERE id=$1",
      [runId],
    );
    const w = startSequenceWorker(env.app.ctx, 100);
    await waitFor(async () => {
      const r = await runDetail(runId);
      const s2 = r.steps.find((s) => s.index === 2)!;
      return s2.scheduledAt !== null && new Date(s2.scheduledAt).getTime() > Date.now() + 1000;
    });
    const run = await runDetail(runId);
    const s2 = run.steps.find((s) => s.index === 2)!;
    const expected = Date.now() + 5000;
    expect(Math.abs(new Date(s2.scheduledAt!).getTime() - expected)).toBeLessThan(1000);
    expect(s2.status).toBe("pending");
    // step3 still unscheduled (chains off step2)
    expect(run.steps.find((s) => s.index === 3)!.scheduledAt).toBeNull();
    await w.stop();
  });
});

describe("run route shape", () => {
  it("GET /api/sequence-runs/:id returns resolvedVars + varSources per step", async () => {
    const { groupId } = await seedGroup(env, token);
    const seq = await createSequence([
      { index: 1, accountRole: "admin", text: "{event} at {location}", delaySeconds: 10 },
    ]);
    const { body } = await startRun(
      groupId,
      seq.body.id!,
      { event: "launch" },
      { "1": { location: "hall" } },
    );
    const run = await runDetail(body.runId!);
    expect(run.steps[0]!.resolvedVars).toEqual({ event: "launch", location: "hall" });
    expect(run.steps[0]!.varSources).toEqual({ event: "default", location: "step:1" });
    expect(run.currentStepIndex).toBe(1);
  });
});
