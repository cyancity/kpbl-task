import crypto from "node:crypto";
import pg from "pg";
import type { AppContext } from "../../context.js";
import { AppError } from "../../errors.js";
import { emitWs } from "../../ws/emit.js";
import { enqueueSend } from "../messages/outbox.js";
import { kickMember } from "../groups/kick.js";
import { AgentClient, AgentTimeoutError } from "./client.js";
import { TOOL_DEFS, validateToolInput } from "./tools.js";
import type { TriggerMessage } from "./trigger.js";

const STEP_BUDGET = 12;
const WALL_CLOCK_MS = 60_000;
const MAX_CONSECUTIVE_PROTOCOL_ERRORS = 3;
const SEND_CONFIRM_MS = 5_000;
const SEND_POLL_MS = 100;
const TOOL_RESULT_MAX_BYTES = 8 * 1024;
const RAW_RESPONSE_MAX = 2048;
const RESULT_SUMMARY_MAX = 200;
const GET_RECENT_MAX_LIMIT = 50;
const GET_RECENT_TEXT_MAX = 500;

interface AgentRun {
  id: string;
  group_id: string;
  status: string;
  end_reason: string | null;
  summary: string | null;
  trigger_messages: TriggerMessage[] | null;
  history: ContentMessage[];
  step_count: number;
  consecutive_protocol_errors: number;
  elapsed_ms: number;
  scratch: {
    lastGetRecentInput?: string;
    getRecentRepeatCount?: number;
  };
  cancel_requested: boolean;
  /**
   * In-memory cursor for elapsed-time billing: the point up to which the
   * current claim has already been charged into elapsed_ms. Each persistence
   * point adds only the delta since the previous one — adding the whole
   * claim duration at every write double-counts and fires wall_clock early.
   */
  billedUntil?: number;
}

interface AgentStep {
  id: string;
  run_id: string;
  seq: number;
  kind: string;
  tool_use_id: string | null;
  name: string | null;
  input: Record<string, unknown> | null;
  state: string | null;
  created_at: Date;
}

type ContentBlock = Record<string, unknown>;
interface ContentMessage {
  role: string;
  content: ContentBlock[];
}

interface ToolOutcome {
  result: Record<string, unknown>;
  isError: boolean;
  errorCode?: string;
  resultSummary: string;
  auditVerdict?: string | null;
  endRun?: { status: string; endReason: string; summary?: string };
}

/** Process boot time: a run persisted before this moment was released by a dead process. */
const BOOT_AT = Date.now();

/**
 * Bill the inter-claim gap into elapsed_ms. The spec clocks a run "from
 * creation" and excludes only downtime, so time spent waiting for the
 * scheduler between steps still counts. The gap is downtime (skipped) when:
 *  - the lease is dangling: the previous claimer crashed mid-step
 *  - the last activity predates this process: released before shutdown
 * Otherwise (normal scheduling gap, or waiting behind other runs) it counts.
 */
const GAP_BILLING_SQL = `
  elapsed_ms = elapsed_ms + CASE
    WHEN lease_until IS NOT NULL THEN 0
    WHEN COALESCE(resumed_at, created_at) < to_timestamp($2::float8 / 1000)
      THEN GREATEST(0, round(extract(epoch from now()) * 1000 - $2))::bigint
    ELSE GREATEST(0, round(extract(epoch from (now() - COALESCE(resumed_at, created_at))) * 1000))::bigint
  END`;

/** Claims one runnable run (SKIP LOCKED + lease) and executes one step. */
export async function runAgentStepOnce(ctx: AppContext): Promise<boolean> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `UPDATE agent_runs SET lease_until = now() + $1 * interval '1 millisecond', resumed_at = now(),
       ${GAP_BILLING_SQL}
     WHERE id = (
       SELECT id FROM agent_runs
       WHERE status = 'running' AND (lease_until IS NULL OR lease_until < now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING id`,
    [ctx.config.agentLeaseMs, BOOT_AT],
  );
  if (!rows[0]) return false;
  await stepRun(ctx, rows[0].id);
  return true;
}

/** Loads and steps a specific run (test helper). Assumes it is claimable. */
export async function stepAgentRun(ctx: AppContext, runId: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE agent_runs SET lease_until = now() + $2 * interval '1 millisecond', resumed_at = now(),
       ${GAP_BILLING_SQL.replace(/\$2/g, "$3")}
     WHERE id=$1`,
    [runId, ctx.config.agentLeaseMs, BOOT_AT],
  );
  await stepRun(ctx, runId);
}

async function loadRun(ctx: AppContext, runId: string): Promise<AgentRun | null> {
  const { rows } = await ctx.pool.query<AgentRun>("SELECT * FROM agent_runs WHERE id=$1", [runId]);
  return rows[0] ?? null;
}

async function loadGroup(ctx: AppContext, groupId: string) {
  const { rows } = await ctx.pool.query<{
    id: string;
    status: string;
    agent_enabled: boolean;
    auto_kick_enabled: boolean;
    gateway_group_id: string | null;
  }>(
    "SELECT id, status, agent_enabled, auto_kick_enabled, gateway_group_id FROM groups WHERE id=$1",
    [groupId],
  );
  return rows[0] ?? null;
}

async function stepRun(ctx: AppContext, runId: string): Promise<void> {
  const claimStart = Date.now();
  const run = await loadRun(ctx, runId);
  if (!run || run.status !== "running") return;
  run.billedUntil = claimStart;

  try {
    // Recovery: a step committed as 'executing' means we crashed mid-flight.
    const { rows: lastSteps } = await ctx.pool.query<AgentStep>(
      "SELECT * FROM agent_steps WHERE run_id=$1 ORDER BY seq DESC LIMIT 1",
      [runId],
    );
    const lastStep = lastSteps[0];
    if (lastStep && lastStep.state === "executing") {
      const group = await loadGroup(ctx, run.group_id);
      const mustCancel =
        !group || group.status !== "active" || !group.agent_enabled || run.cancel_requested;
      await resolveExecutingStep(ctx, run, lastStep);
      if (mustCancel) {
        // resolveExecutingStep may leave the step 'executing' when the gateway
        // probe cannot confirm the outcome — cancel must land anyway or the
        // run hangs in 'running' forever and is impossible to stop.
        await ctx.pool.query(
          `UPDATE agent_steps SET state='done', is_error=true, error_code='CANCELLED',
                  result_summary='cancelled while awaiting confirmation'
           WHERE id=$1 AND state='executing'`,
          [lastStep.id],
        );
        await endRun(ctx, run, "cancelled", "cancelled");
        return;
      }
      await persistAfterStep(ctx, run);
      await maybeCancelAfterStep(ctx, run);
      return;
    }

    const group = await loadGroup(ctx, run.group_id);
    if (!group || group.status !== "active" || !group.agent_enabled || run.cancel_requested) {
      await endRun(ctx, run, "cancelled", "cancelled");
      return;
    }
    if (run.step_count >= STEP_BUDGET) {
      await endRun(ctx, run, "failed", "budget_exhausted");
      return;
    }
    if (run.elapsed_ms >= WALL_CLOCK_MS) {
      await endRun(ctx, run, "failed", "wall_clock");
      return;
    }

    await executeTurn(ctx, run, group);
  } catch (err) {
    // Release the lease so a later claim can resume from persisted state.
    await ctx.pool
      .query("UPDATE agent_runs SET lease_until = NULL WHERE id=$1 AND status='running'", [runId])
      .catch(() => {});
    ctx.log.error({ err, runId }, "agent step failed");
  }
}

function triggerMessage(
  run: AgentRun,
  group: { id: string; auto_kick_enabled: boolean },
  ownIds: string[],
) {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          groupId: group.id,
          triggerMessages: run.trigger_messages ?? [],
          policy: { autoKickEnabled: group.auto_kick_enabled },
          ownPlatformUserIds: ownIds,
        }),
      },
    ],
  };
}

async function executeTurn(
  ctx: AppContext,
  run: AgentRun,
  group: {
    id: string;
    status: string;
    agent_enabled: boolean;
    auto_kick_enabled: boolean;
    gateway_group_id: string | null;
  },
): Promise<void> {
  const { rows: ownRows } = await ctx.pool.query<{ platform_user_id: string }>(
    "SELECT platform_user_id FROM group_members WHERE group_id=$1 AND account_id IS NOT NULL",
    [run.group_id],
  );
  const agent = new AgentClient(ctx.config.agentUrl);
  const messages = [
    triggerMessage(
      run,
      group,
      ownRows.map((r) => r.platform_user_id),
    ),
    ...run.history,
  ];

  let rawResponse = "";
  let parsed: { stop_reason?: unknown; content?: unknown } | null = null;
  let protocolError: string | null = null;
  try {
    const res = await agent.turn(run.id, TOOL_DEFS, messages, ctx.config.agentTurnTimeoutMs);
    rawResponse = res.bodyText.slice(0, RAW_RESPONSE_MAX);
    if (res.status < 200 || res.status >= 300) {
      protocolError = "BAD_JSON";
    } else {
      try {
        parsed = JSON.parse(res.bodyText);
      } catch {
        protocolError = "BAD_JSON";
      }
    }
  } catch (err) {
    if (err instanceof AgentTimeoutError) {
      protocolError = "TURN_TIMEOUT";
    } else {
      protocolError = "TURN_TIMEOUT"; // network failure: response unknown, same handling
    }
  }

  let block: ContentBlock | null = null;
  if (parsed && !protocolError) {
    const sr = parsed.stop_reason;
    const content = parsed.content;
    if (
      (sr !== "tool_use" && sr !== "end_turn") ||
      !Array.isArray(content) ||
      content.length !== 1
    ) {
      protocolError = "BAD_JSON";
    } else {
      block = content[0] as ContentBlock;
      const expected = sr === "tool_use" ? "tool_use" : "text";
      if (block.type !== expected) {
        protocolError = "BAD_JSON";
      } else if (sr === "tool_use") {
        const id = block.id;
        if (typeof id !== "string") {
          protocolError = "BAD_JSON";
        } else if (historyHasToolUseId(run.history, id)) {
          protocolError = "DUPLICATE_TOOL_USE_ID";
        }
      }
    }
  }

  if (protocolError) {
    await recordProtocolError(ctx, run, protocolError, rawResponse);
    return;
  }

  run.consecutive_protocol_errors = 0;
  run.step_count += 1;
  const sr = parsed!.stop_reason as string;
  block = block!;

  if (sr === "end_turn") {
    const text = typeof block.text === "string" ? block.text : "";
    // Step row and terminal run state commit together: a crash between them
    // would leave step_count behind the steps table and wedge the run on the
    // (run_id, seq) unique index at recovery.
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await insertStep(client, run, {
        seq: run.step_count,
        kind: "final",
        resultSummary: text.slice(0, RESULT_SUMMARY_MAX),
        state: "done",
      });
      await endRunTx(client, run, "finished", "final", text);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  // tool_use
  const name = String(block.name ?? "");
  const input = (block.input ?? {}) as Record<string, unknown>;
  const toolUseId = String(block.id);

  if (name === "send_message" || name === "kick_user") {
    await executeMutatingTool(ctx, run, group, { id: toolUseId, name, input });
    return;
  }

  // Read-only / final tools: assistant block + step + tool_result + run state
  // in one tx (same crash-safety argument as end_turn above).
  const outcome = await dispatchReadOnlyTool(ctx, run, group, name, input);
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    run.history.push({
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
    });
    run.history.push(toolResultMessage(toolUseId, outcome));
    await insertStep(client, run, {
      seq: run.step_count,
      kind: outcome.endRun?.status === "finished" ? "final" : "tool_use",
      toolUseId,
      name,
      input,
      isError: outcome.isError,
      errorCode: outcome.errorCode ?? null,
      resultSummary: outcome.resultSummary,
      state: "done",
    });
    if (outcome.endRun) {
      await endRunTx(
        client,
        run,
        outcome.endRun.status,
        outcome.endRun.endReason,
        outcome.endRun.summary,
      );
    } else {
      await persistRunTx(client, run, { releaseLease: true });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!outcome.endRun) {
    await maybeCancelAfterStep(ctx, run);
  }
}

function historyHasToolUseId(history: ContentMessage[], id: string): boolean {
  return history.some(
    (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.id === id),
  );
}

const PROTOCOL_MESSAGES: Record<string, string> = {
  BAD_JSON: "response was not a valid single-block tool message",
  DUPLICATE_TOOL_USE_ID: "tool_use id was already used in this run",
  TURN_TIMEOUT: "agent did not respond within the turn timeout",
};

async function recordProtocolError(
  ctx: AppContext,
  run: AgentRun,
  code: string,
  rawResponse: string,
): Promise<void> {
  run.step_count += 1;
  run.consecutive_protocol_errors += 1;
  run.history.push({
    role: "user",
    content: [{ type: "text", text: `PROTOCOL_ERROR ${code}: ${PROTOCOL_MESSAGES[code]}` }],
  });
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await insertStep(client, run, {
      seq: run.step_count,
      kind: "protocol_error",
      isError: true,
      errorCode: code,
      rawResponse,
      state: "done",
    });
    // Step row and run state must commit together (crash-safety).
    if (run.consecutive_protocol_errors >= MAX_CONSECUTIVE_PROTOCOL_ERRORS) {
      await endRunTx(client, run, "failed", "protocol_errors");
    } else {
      await persistRunTx(client, run, { releaseLease: true });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface StepInsert {
  seq: number;
  kind: string;
  toolUseId?: string | null;
  name?: string | null;
  input?: Record<string, unknown> | null;
  isError?: boolean;
  errorCode?: string | null;
  auditVerdict?: string | null;
  resultSummary?: string | null;
  rawResponse?: string | null;
  clientMsgId?: string | null;
  state?: string | null;
}

async function insertStep(
  q: pg.Pool | pg.PoolClient,
  run: AgentRun,
  s: StepInsert,
): Promise<string> {
  const id = crypto.randomUUID();
  await q.query(
    `INSERT INTO agent_steps
       (id, run_id, seq, kind, tool_use_id, name, input, state, result_summary,
        is_error, error_code, audit_verdict, raw_response, client_msg_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      run.id,
      s.seq,
      s.kind,
      s.toolUseId ?? null,
      s.name ?? null,
      s.input ? JSON.stringify(s.input) : null,
      s.state ?? null,
      s.resultSummary ?? null,
      s.isError ?? false,
      s.errorCode ?? null,
      s.auditVerdict ?? null,
      s.rawResponse ?? null,
      s.clientMsgId ?? null,
    ],
  );
  return id;
}

function toolResultMessage(toolUseId: string, outcome: ToolOutcome): ContentMessage {
  // The spec requires content <= 8KB and `truncated: true` on oversized
  // results. Cutting the serialized JSON mid-string produces invalid JSON and
  // can cut the marker itself, so shrink at the data level instead: drop
  // trailing messages until the result fits, keeping a valid object.
  let result = outcome.result;
  let content = JSON.stringify(result);
  if (Buffer.byteLength(content, "utf8") > TOOL_RESULT_MAX_BYTES) {
    if (Array.isArray(result.messages)) {
      const messages = [...(result.messages as unknown[])];
      while (
        messages.length > 0 &&
        Buffer.byteLength(
          JSON.stringify({ ...result, messages, truncated: true }),
          "utf8",
        ) > TOOL_RESULT_MAX_BYTES
      ) {
        messages.pop();
      }
      result = { ...result, messages, truncated: true };
    } else {
      result = {
        truncated: true,
        preview: content.slice(0, TOOL_RESULT_MAX_BYTES - 256),
      };
    }
    content = JSON.stringify(result);
    while (Buffer.byteLength(content, "utf8") > TOOL_RESULT_MAX_BYTES) {
      result = { truncated: true, preview: String(result.preview ?? "").slice(0, 1024) };
      content = JSON.stringify(result);
    }
  }
  const block: ContentBlock = { type: "tool_result", tool_use_id: toolUseId, content };
  if (outcome.isError) block.is_error = true;
  return { role: "user", content: [block] };
}

async function dispatchReadOnlyTool(
  ctx: AppContext,
  run: AgentRun,
  group: { id: string },
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (!TOOL_DEFS.some((t) => t.name === name)) {
    return errOutcome("UNKNOWN_TOOL", `tool ${name} is not in the tool list`);
  }
  const valid = validateToolInput(name, input);
  if (!valid.ok) return errOutcome("INVALID_INPUT", valid.message);

  if (name === "finish") {
    return {
      result: { ok: true },
      isError: false,
      resultSummary: "finish",
      endRun: { status: "finished", endReason: "final", summary: String(input.summary ?? "") },
    };
  }

  // get_recent_messages
  const inputKey = JSON.stringify(input);
  const repeat =
    run.scratch.lastGetRecentInput === inputKey ? (run.scratch.getRecentRepeatCount ?? 1) + 1 : 1;
  run.scratch.lastGetRecentInput = inputKey;
  run.scratch.getRecentRepeatCount = repeat;
  if (repeat >= 3) {
    return {
      result: {
        code: "INVALID_INPUT",
        message: "repeated identical get_recent_messages",
        hint: "call finish",
      },
      isError: true,
      errorCode: "INVALID_INPUT",
      resultSummary: "repeated identical get_recent_messages",
    };
  }

  const limit = Math.min(Math.max(1, Number(input.limit) || 1), GET_RECENT_MAX_LIMIT);
  const { rows } = await ctx.pool.query<{
    msg_id: string | null;
    sender_platform_user_id: string | null;
    is_own: boolean;
    text: string | null;
    sent_at: Date;
  }>(
    "SELECT msg_id, sender_platform_user_id, is_own, text, sent_at FROM messages WHERE group_id=$1 ORDER BY sent_at DESC, id DESC LIMIT $2",
    [run.group_id, limit],
  );
  let truncated = false;
  const messages = rows.reverse().map((r) => {
    let text = r.text ?? "";
    if (text.length > GET_RECENT_TEXT_MAX) {
      text = text.slice(0, GET_RECENT_TEXT_MAX);
      truncated = true;
    }
    return {
      msgId: r.msg_id,
      senderPlatformUserId: r.sender_platform_user_id,
      isOwn: r.is_own,
      text,
      sentAt: r.sent_at.getTime(),
    };
  });
  const result: Record<string, unknown> = { messages, truncated };
  if (repeat === 2) {
    result.hint = "identical to previous call; call finish when done";
  }
  return {
    result,
    isError: false,
    resultSummary: `get_recent_messages -> ${messages.length} messages`,
  };
}

function errOutcome(code: string, message: string): ToolOutcome {
  return {
    result: { code, message },
    isError: true,
    errorCode: code,
    resultSummary: `${code}: ${message}`.slice(0, RESULT_SUMMARY_MAX),
  };
}

type AuditOutcome = "pass" | "fail" | "indeterminate";

async function auditWithRetry(
  ctx: AppContext,
  run: AgentRun,
  groupId: string,
  text: string,
): Promise<AuditOutcome> {
  const agent = new AgentClient(ctx.config.agentUrl);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await agent.audit(text, groupId, ctx.config.auditTimeoutMs);
      if (res.status >= 200 && res.status < 300) {
        const json = JSON.parse(res.bodyText) as { verdict?: string };
        if (json.verdict === "pass") return "pass";
        if (json.verdict === "fail") return "fail";
      }
    } catch {
      // indefinite: bad JSON, timeout, network — retry
    }
  }
  return "indeterminate";
}

async function pickSendAccount(ctx: AppContext, groupId: string): Promise<string | null> {
  const { rows } = await ctx.pool.query<{ account_id: string }>(
    `SELECT m.account_id FROM group_members m JOIN accounts a ON a.id = m.account_id
     WHERE m.group_id=$1 AND a.status='online'
     ORDER BY CASE m.role WHEN 'creator' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.account_id`,
    [groupId],
  );
  return rows[0]?.account_id ?? null;
}

async function pickKickAccount(ctx: AppContext, groupId: string): Promise<string | null> {
  const { rows } = await ctx.pool.query<{ account_id: string }>(
    `SELECT m.account_id FROM group_members m JOIN accounts a ON a.id = m.account_id
     WHERE m.group_id=$1 AND a.status='online' AND m.role IN ('creator','admin')
     ORDER BY CASE m.role WHEN 'admin' THEN 0 ELSE 1 END, m.account_id`,
    [groupId],
  );
  return rows[0]?.account_id ?? null;
}

async function executeMutatingTool(
  ctx: AppContext,
  run: AgentRun,
  group: { id: string; auto_kick_enabled: boolean; gateway_group_id: string | null },
  tool: { id: string; name: string; input: Record<string, unknown> },
): Promise<void> {
  const { id: toolUseId, name, input } = tool;
  const seq = run.step_count;
  const assistantBlock: ContentMessage = {
    role: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name, input }],
  };

  const failStep = async (outcome: ToolOutcome) => {
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      run.history.push(assistantBlock);
      run.history.push(toolResultMessage(toolUseId, outcome));
      await insertStep(client, run, {
        seq,
        kind: "tool_use",
        toolUseId,
        name,
        input,
        isError: outcome.isError,
        errorCode: outcome.errorCode ?? null,
        auditVerdict: outcome.auditVerdict ?? null,
        resultSummary: outcome.resultSummary,
        state: "done",
      });
      // Step row and run state commit together (crash-safety).
      if (outcome.endRun) {
        await endRunTx(
          client,
          run,
          outcome.endRun.status,
          outcome.endRun.endReason,
          outcome.endRun.summary,
        );
      } else {
        await persistRunTx(client, run, { releaseLease: true });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (!outcome.endRun) {
      await maybeCancelAfterStep(ctx, run);
    }
  };

  const valid = validateToolInput(name, input);
  if (!valid.ok) return failStep(errOutcome("INVALID_INPUT", valid.message));

  if (name === "kick_user" && !group.auto_kick_enabled) {
    return failStep(errOutcome("POLICY_DENIED", "autoKickEnabled is false for this group"));
  }

  if (name === "send_message") {
    // Idempotent replay: same key already executed in this run.
    const { rows: idem } = await ctx.pool.query<{ client_msg_id: string }>(
      "SELECT client_msg_id FROM agent_idempotency WHERE run_id=$1 AND key=$2",
      [run.id, String(input.idempotency_key)],
    );
    if (idem[0]) {
      const { rows: msg } = await ctx.pool.query<{ delivery_status: string | null }>(
        "SELECT delivery_status FROM messages WHERE client_msg_id=$1",
        [idem[0].client_msg_id],
      );
      return failStep({
        result: {
          clientMsgId: idem[0].client_msg_id,
          deliveryStatus: msg[0]?.delivery_status ?? "unknown",
        },
        isError: false,
        resultSummary: "idempotent replay",
      });
    }
  }

  const accountId =
    name === "send_message"
      ? await pickSendAccount(ctx, run.group_id)
      : await pickKickAccount(ctx, run.group_id);
  if (!accountId) {
    return failStep(
      errOutcome("NO_AVAILABLE_ACCOUNT", "no online member account can execute this"),
    );
  }

  const auditText =
    name === "send_message"
      ? String(input.text)
      : JSON.stringify({
          action: "kick",
          platform_user_id: input.platform_user_id,
          reason: input.reason,
        });
  const audit = await auditWithRetry(ctx, run, run.group_id, auditText);
  if (audit === "fail") {
    return failStep({
      ...errOutcome("AUDIT_REJECTED", "audit returned verdict fail"),
      auditVerdict: "fail",
    });
  }
  if (audit === "indeterminate") {
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      run.history.push(assistantBlock);
      await insertStep(client, run, {
        seq,
        kind: "tool_use",
        toolUseId,
        name,
        input,
        resultSummary: "audit indeterminate after 3 attempts",
        auditVerdict: "indeterminate",
        state: "done",
      });
      await emitWs(client, "inconsistency", {
        kind: "audit_blocked",
        ref: run.id,
        message: "agent audit did not produce a definite verdict",
      });
      await endRunTx(client, run, "blocked", "audit_blocked");
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return;
  }

  // Commit the executing step + side effects in one tx (crash-safe ordering).
  const clientMsgId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    run.history.push(assistantBlock);
    if (name === "send_message") {
      await client.query(
        `INSERT INTO agent_steps
           (id, run_id, seq, kind, tool_use_id, name, input, state, audit_verdict, client_msg_id)
         VALUES ($1,$2,$3,'tool_use',$4,$5,$6,'executing','pass',$7)`,
        [stepId, run.id, seq, toolUseId, name, JSON.stringify(input), clientMsgId],
      );
      await client.query(
        "INSERT INTO agent_idempotency (run_id, key, client_msg_id) VALUES ($1,$2,$3)",
        [run.id, String(input.idempotency_key), clientMsgId],
      );
      await enqueueSend(client, {
        groupId: run.group_id,
        accountId,
        text: String(input.text),
        agentStepId: stepId,
        clientMsgId,
      });
    } else {
      await client.query(
        `INSERT INTO agent_steps
           (id, run_id, seq, kind, tool_use_id, name, input, state, audit_verdict)
         VALUES ($1,$2,$3,'tool_use',$4,$5,$6,'executing','pass')`,
        [stepId, run.id, seq, toolUseId, name, JSON.stringify(input)],
      );
    }
    await persistRunTx(client, run);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (process.env.ENABLE_FAULT_INJECTION === "1" && ctx.faults.failAfterExecuting) {
    ctx.faults.failAfterExecuting = false;
    throw new Error("injected crash after executing step commit");
  }

  const outcome =
    name === "send_message"
      ? await awaitSendOutcome(ctx, clientMsgId, SEND_CONFIRM_MS)
      : await executeKick(ctx, group.id, accountId, String(input.platform_user_id));

  await finalizeExecutingStep(ctx, run, { id: stepId, tool_use_id: toolUseId }, outcome);
  await ctx.pool.query("UPDATE agent_runs SET lease_until=NULL WHERE id=$1 AND status='running'", [
    run.id,
  ]);
  await maybeCancelAfterStep(ctx, run);
}

async function awaitSendOutcome(
  ctx: AppContext,
  clientMsgId: string,
  budgetMs: number,
): Promise<ToolOutcome> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { rows } = await ctx.pool.query<{
      delivery_status: string | null;
      fail_code: string | null;
    }>("SELECT delivery_status, fail_code FROM messages WHERE client_msg_id=$1", [clientMsgId]);
    const status = rows[0]?.delivery_status;
    if (status === "accepted" || status === "sent") {
      return {
        result: { clientMsgId, deliveryStatus: status },
        isError: false,
        resultSummary: `sent (${status})`,
      };
    }
    if (status === "failed" || status === "cancelled") {
      const code = rows[0]?.fail_code;
      if (code === "GROUP_WRITE_FORBIDDEN" || code === "GROUP_UNREACHABLE") {
        return errOutcome("GROUP_UNREACHABLE", "group is not writable");
      }
      return errOutcome("SEND_FAILED", `message delivery failed (${code ?? status})`);
    }
    if (Date.now() >= deadline) {
      return errOutcome("SEND_TIMEOUT", "send not confirmed within 5s; the key stays consumed");
    }
    await new Promise((r) => setTimeout(r, SEND_POLL_MS));
  }
}

async function executeKick(
  ctx: AppContext,
  groupId: string,
  byAccountId: string,
  targetPlatformUserId: string,
): Promise<ToolOutcome> {
  try {
    await kickMember(ctx, { groupId, byAccountId, targetPlatformUserId });
    return { result: { kicked: true }, isError: false, resultSummary: "kicked" };
  } catch (err) {
    if (err instanceof AppError) {
      return errOutcome(err.code, err.message);
    }
    throw err;
  }
}

async function finalizeExecutingStep(
  ctx: AppContext,
  run: AgentRun,
  step: Pick<AgentStep, "id" | "tool_use_id"> & Partial<AgentStep>,
  outcome: ToolOutcome,
): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    run.history.push(toolResultMessage(step.tool_use_id!, outcome));
    await client.query(
      `UPDATE agent_steps SET state='done', result_summary=$2, is_error=$3, error_code=$4
       WHERE id=$1`,
      [step.id, outcome.resultSummary, outcome.isError, outcome.errorCode ?? null],
    );
    await persistRunTx(client, run);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Crash recovery: a committed 'executing' step gets resolved, never re-executed. */
async function resolveExecutingStep(
  ctx: AppContext,
  run: AgentRun,
  step: AgentStep,
): Promise<void> {
  let outcome: ToolOutcome;
  if (step.name === "send_message") {
    const { rows } = await ctx.pool.query<{ client_msg_id: string; created_at: Date }>(
      "SELECT client_msg_id, created_at FROM agent_steps WHERE id=$1",
      [step.id],
    );
    const clientMsgId = rows[0]?.client_msg_id;
    if (!clientMsgId) {
      outcome = errOutcome("SEND_FAILED", "executing step had no message");
    } else {
      const remaining = Math.max(0, SEND_CONFIRM_MS - (Date.now() - step.created_at.getTime()));
      outcome = await awaitSendOutcome(ctx, clientMsgId, remaining);
    }
  } else {
    // kick_user: confirm via gateway members list.
    const group = await loadGroup(ctx, run.group_id);
    const target = String(step.input?.platform_user_id ?? "");
    let absent = false;
    if (group?.gateway_group_id) {
      try {
        const members = await ctx.gateway.members(group.gateway_group_id);
        absent = !members.some((m) => m.platformUserId === target);
      } catch {
        // Gateway probe failed: keep the step 'executing' so the next claim
        // retries the confirmation instead of recording a false verdict.
        return;
      }
    }
    outcome = absent
      ? { result: { kicked: true }, isError: false, resultSummary: "kicked" }
      : errOutcome("NETWORK_TIMEOUT", "kick result could not be confirmed after restart");
  }
  await finalizeExecutingStep(ctx, run, step, outcome);
}

/** After a non-ending step, external state may demand cancellation. */
async function maybeCancelAfterStep(ctx: AppContext, run: AgentRun) {
  const fresh = await loadRun(ctx, run.id);
  const group = await loadGroup(ctx, run.group_id);
  if (!fresh || fresh.status !== "running") return;
  fresh.billedUntil = run.billedUntil ?? Date.now();
  if (!group || group.status !== "active" || !group.agent_enabled || fresh.cancel_requested) {
    await endRun(ctx, fresh, "cancelled", "cancelled");
  }
}

/** Milliseconds of this claim not yet charged into elapsed_ms. */
function billDelta(run: AgentRun): number {
  const now = Date.now();
  const from = run.billedUntil ?? now;
  run.billedUntil = now;
  return Math.max(0, now - from);
}

/** Persists run fields inside an existing transaction. */
async function persistRunTx(
  client: pg.PoolClient,
  run: AgentRun,
  opts: { releaseLease?: boolean } = {},
): Promise<void> {
  const delta = billDelta(run);
  await client.query(
    `UPDATE agent_runs SET history=$2, step_count=$3, consecutive_protocol_errors=$4,
       scratch=$5, elapsed_ms = elapsed_ms + $6, resumed_at=now()
       ${opts.releaseLease ? ", lease_until=NULL" : ""}
     WHERE id=$1`,
    [
      run.id,
      JSON.stringify(run.history),
      run.step_count,
      run.consecutive_protocol_errors,
      JSON.stringify(run.scratch ?? {}),
      delta,
    ],
  );
}

/** Persists state after a step and releases the claim (standalone update). */
async function persistAfterStep(ctx: AppContext, run: AgentRun) {
  const delta = billDelta(run);
  await ctx.pool.query(
    `UPDATE agent_runs SET history=$2, step_count=$3, consecutive_protocol_errors=$4,
       scratch=$5, elapsed_ms = elapsed_ms + $6, resumed_at=now(), lease_until=NULL
     WHERE id=$1 AND status='running'`,
    [
      run.id,
      JSON.stringify(run.history),
      run.step_count,
      run.consecutive_protocol_errors,
      JSON.stringify(run.scratch ?? {}),
      delta,
    ],
  );
}

/**
 * Terminal transition inside an existing transaction: run fields, the ws
 * notification and the pending-message handoff to a follow-up run all commit
 * atomically. Returns false when the run was no longer running (a concurrent
 * path already ended it) — callers must then skip their own emits.
 */
async function endRunTx(
  client: pg.PoolClient,
  run: AgentRun,
  status: string,
  endReason: string,
  summary?: string,
): Promise<boolean> {
  const delta = billDelta(run);
  const { rowCount } = await client.query(
    `UPDATE agent_runs SET status=$2, end_reason=$3, summary=COALESCE($4, summary),
       ended_at=now(), lease_until=NULL, elapsed_ms = elapsed_ms + $5, resumed_at=now(),
       history=$6, step_count=$7, consecutive_protocol_errors=$8, scratch=$9
     WHERE id=$1 AND status='running'`,
    [
      run.id,
      status,
      endReason,
      summary ?? null,
      delta,
      JSON.stringify(run.history),
      run.step_count,
      run.consecutive_protocol_errors,
      JSON.stringify(run.scratch ?? {}),
    ],
  );
  if (!rowCount) return false;
  await emitWs(client, "agent_run", {
    runId: run.id,
    groupId: run.group_id,
    status,
    endReason,
  });

  // Chain: pending messages become the next run's triggers when the group
  // is still active and agent-enabled; otherwise they are discarded.
  const { rows: pending } = await client.query<{ message_pk: number }>(
    "DELETE FROM agent_pending_messages WHERE run_group_id=$1 RETURNING message_pk",
    [run.group_id],
  );
  if (pending.length > 0) {
    const { rows: grp } = await client.query<{ ok: boolean }>(
      "SELECT (status='active' AND agent_enabled) AS ok FROM groups WHERE id=$1",
      [run.group_id],
    );
    if (grp[0]?.ok) {
      const ids = pending.map((p) => p.message_pk);
      const { rows: msgs } = await client.query<{
        msg_id: string | null;
        sender_platform_user_id: string | null;
        text: string | null;
        sent_at: Date;
      }>(
        `SELECT msg_id, sender_platform_user_id, text, sent_at FROM messages
         WHERE id = ANY($1) ORDER BY sent_at, id`,
        [ids],
      );
      const triggerMessages = msgs.map((m) => ({
        msgId: m.msg_id,
        senderPlatformUserId: m.sender_platform_user_id,
        text: m.text,
        sentAt: m.sent_at.getTime(),
      }));
      const nextRunId = crypto.randomUUID();
      await client.query(
        "INSERT INTO agent_runs (id, group_id, status, trigger_messages) VALUES ($1,$2,'running',$3)",
        [nextRunId, run.group_id, JSON.stringify(triggerMessages)],
      );
      await emitWs(client, "agent_run", {
        runId: nextRunId,
        groupId: run.group_id,
        status: "running",
        endReason: null,
      });
    }
  }
  return true;
}

/** Standalone terminal transition: wraps endRunTx in its own transaction. */
async function endRun(
  ctx: AppContext,
  run: AgentRun,
  status: string,
  endReason: string,
  summary?: string,
): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await endRunTx(client, run, status, endReason, summary);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
