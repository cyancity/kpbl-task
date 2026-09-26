import crypto from "node:crypto";
import pg from "pg";
import type { AppContext } from "../../context.js";
import { AppError } from "../../errors.js";
import { emitWs } from "../../ws/emit.js";
import { enqueueSend } from "../messages/outbox.js";
import { resolveSequence, UnresolvedPlaceholder } from "./resolve.js";

const RESTART_GAP_MS = 5_000;
const OVERDUE_GRACE_MS = 1_000;

export interface SequenceStepDef {
  index: number;
  accountRole: "admin" | "member";
  text: string;
  delaySeconds: number;
}

interface RunRow {
  id: string;
  group_id: string;
  sequence_id: string;
  status: string;
  current_step_index: number | null;
  last_tick_at: Date | null;
}

interface StepRow {
  id: string;
  run_id: string;
  index: number;
  status: string;
  scheduled_at: Date | null;
  sent_at: Date | null;
  client_msg_id: string | null;
  resolved_text: string | null;
  account_id: string | null;
}

/**
 * Starts a sequence run. Precheck resolves all placeholders first so a bad
 * launch leaves no rows behind.
 */
export async function startSequenceRun(
  ctx: AppContext,
  opts: {
    groupId: string;
    sequenceId: string;
    vars?: Record<string, string>;
    stepVars?: Record<string, Record<string, string>>;
  },
): Promise<{ runId: string }> {
  const { rows: groups } = await ctx.pool.query<{ status: string }>(
    "SELECT status FROM groups WHERE id=$1",
    [opts.groupId],
  );
  if (!groups[0]) {
    throw new AppError(404, "GROUP_NOT_FOUND", `group ${opts.groupId} not found`);
  }
  const { rows: seqs } = await ctx.pool.query<{ steps: SequenceStepDef[] }>(
    "SELECT steps FROM sequences WHERE id=$1",
    [opts.sequenceId],
  );
  if (!seqs[0]) {
    throw new AppError(404, "SEQUENCE_NOT_FOUND", `sequence ${opts.sequenceId} not found`);
  }
  if (groups[0].status !== "active") {
    throw new AppError(409, "GROUP_NOT_ACTIVE", `group ${opts.groupId} is ${groups[0].status}`);
  }

  let resolved: ReturnType<typeof resolveSequence>;
  try {
    resolved = resolveSequence(seqs[0].steps, opts.vars, opts.stepVars);
  } catch (err) {
    if (err instanceof UnresolvedPlaceholder) {
      throw new AppError(422, "UNRESOLVED_PLACEHOLDER", err.message, {
        stepIndex: err.stepIndex,
        key: err.key,
      });
    }
    throw err;
  }

  const defs = [...seqs[0].steps].sort((a, b) => a.index - b.index);
  const runId = crypto.randomUUID();
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO sequence_runs (id, group_id, sequence_id, status, current_step_index, vars, step_vars, last_tick_at)
         VALUES ($1,$2,$3,'running',$4,$5,$6,now())`,
        [
          runId,
          opts.groupId,
          opts.sequenceId,
          defs[0]!.index,
          JSON.stringify(opts.vars ?? {}),
          JSON.stringify(opts.stepVars ?? {}),
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new AppError(409, "SEQUENCE_ALREADY_RUNNING", `group ${opts.groupId} has a running sequence`);
      }
      throw err;
    }
    const byIndex = new Map(resolved.steps.map((s) => [s.index, s]));
    for (const def of defs) {
      const r = byIndex.get(def.index)!;
      await client.query(
        `INSERT INTO sequence_run_steps
           (id, run_id, index, status, scheduled_at, resolved_vars, var_sources, resolved_text)
         VALUES ($7,$1,$2,'pending',$3,$4,$5,$6)`,
        [
          runId,
          def.index,
          def.index === defs[0]!.index
            ? new Date(Date.now() + def.delaySeconds * 1000)
            : null,
          JSON.stringify(r.resolvedVars),
          JSON.stringify(r.varSources),
          r.text,
          crypto.randomUUID(),
        ],
      );
    }
    await emitWs(client, "sequence_run", {
      runId,
      groupId: opts.groupId,
      status: "running",
      currentStepIndex: defs[0]!.index,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { runId };
}

async function pickAccount(
  client: pg.PoolClient,
  groupId: string,
  role: "admin" | "member",
): Promise<{ account_id: string; status: string; rate_limited_until: Date | null } | null> {
  const { rows } = await client.query<{
    account_id: string;
    status: string;
    rate_limited_until: Date | null;
  }>(
    `SELECT m.account_id, a.status, a.rate_limited_until FROM group_members m
       JOIN accounts a ON a.id = m.account_id
      WHERE m.group_id=$1 AND a.status IN ('online','rate_limited')
        AND m.role ${role === "admin" ? "IN ('creator','admin')" : "= 'member'"}
      ORDER BY (a.status = 'online') DESC,
               ${role === "admin" ? "(m.role = 'admin') DESC," : ""}
               m.account_id ASC`,
    [groupId],
  );
  return rows[0] ?? null;
}

async function advance(
  client: pg.PoolClient,
  run: RunRow,
  stepIndex: number,
  anchorSentAt: Date,
  stepDefs: Map<number, SequenceStepDef>,
  orderedIndexes: number[],
): Promise<void> {
  const pos = orderedIndexes.indexOf(stepIndex);
  const nextIndex = pos >= 0 ? orderedIndexes[pos + 1] : undefined;
  if (nextIndex === undefined) {
    const { rows } = await client.query<{ failed: boolean }>(
      "SELECT bool_or(status='failed') AS failed FROM sequence_run_steps WHERE run_id=$1",
      [run.id],
    );
    const status = rows[0]?.failed ? "failed" : "finished";
    await client.query(
      "UPDATE sequence_runs SET status=$2, current_step_index=NULL, updated_at=now(), lease_until=NULL WHERE id=$1",
      [run.id, status],
    );
    await emitWs(client, "sequence_run", {
      runId: run.id,
      groupId: run.group_id,
      status,
      currentStepIndex: null,
    });
    return;
  }
  const nextDelay = stepDefs.get(nextIndex)!.delaySeconds;
  await client.query(
    "UPDATE sequence_run_steps SET scheduled_at=$3 WHERE run_id=$1 AND index=$2",
    [run.id, nextIndex, new Date(anchorSentAt.getTime() + nextDelay * 1000)],
  );
  await client.query(
    "UPDATE sequence_runs SET current_step_index=$2, updated_at=now(), lease_until=NULL WHERE id=$1",
    [run.id, nextIndex],
  );
  await emitWs(client, "sequence_run", {
    runId: run.id,
    groupId: run.group_id,
    status: "running",
    currentStepIndex: nextIndex,
  });
}

/** One scheduler step for a claimed run. Called by the worker with the lease held. */
export async function tickSequenceRun(ctx: AppContext, runId: string): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: runs } = await client.query<RunRow>(
      "SELECT * FROM sequence_runs WHERE id=$1 FOR UPDATE",
      [runId],
    );
    const run = runs[0];
    if (!run || run.status !== "running") {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: steps } = await client.query<StepRow>(
      "SELECT * FROM sequence_run_steps WHERE run_id=$1 ORDER BY index",
      [runId],
    );
    const { rows: seqs } = await client.query<{ steps: SequenceStepDef[] }>(
      "SELECT steps FROM sequences WHERE id=$1",
      [run.sequence_id],
    );
    const stepDefs = new Map((seqs[0]?.steps ?? []).map((s) => [s.index, s]));
    const orderedIndexes = steps.map((s) => s.index);
    const current = steps.find((s) => s.index === run.current_step_index);
    const now = new Date();

    // Restart rule: a run that hasn't been ticked for >5s counts as resumed;
    // its overdue pending step is rescheduled to now + its own delaySeconds.
    const resumed =
      !run.last_tick_at || now.getTime() - run.last_tick_at.getTime() > RESTART_GAP_MS;
    await client.query("UPDATE sequence_runs SET last_tick_at=now() WHERE id=$1", [run.id]);

    if (!current || current.status !== "pending") {
      // Step advanced/skipped by another path (e.g. terminal cascade) — move on.
      if (current && (current.status === "skipped" || current.status === "failed")) {
        await advance(client, run, current.index, current.sent_at ?? now, stepDefs, orderedIndexes);
      } else if (current?.status === "sent") {
        await advance(client, run, current.index, current.sent_at ?? now, stepDefs, orderedIndexes);
      } else {
        await client.query("UPDATE sequence_runs SET lease_until=NULL WHERE id=$1", [run.id]);
      }
      await client.query("COMMIT");
      return;
    }

    if (
      resumed &&
      current.scheduled_at &&
      current.scheduled_at.getTime() < now.getTime() - OVERDUE_GRACE_MS
    ) {
      const delay = stepDefs.get(current.index)?.delaySeconds ?? 0;
      await client.query(
        "UPDATE sequence_run_steps SET scheduled_at=$3 WHERE run_id=$1 AND index=$2",
        [runId, current.index, new Date(now.getTime() + delay * 1000)],
      );
      await client.query("UPDATE sequence_runs SET lease_until=NULL WHERE id=$1", [runId]);
      await client.query("COMMIT");
      return;
    }

    if (current.scheduled_at && current.scheduled_at.getTime() > now.getTime()) {
      // Not yet due.
      await client.query("UPDATE sequence_runs SET lease_until=NULL WHERE id=$1", [runId]);
      await client.query("COMMIT");
      return;
    }

    const def = stepDefs.get(current.index)!;
    const account = await pickAccount(client, run.group_id, def.accountRole);
    if (!account) {
      await client.query(
        "UPDATE sequence_run_steps SET status='skipped', sent_at=now() WHERE id=$1",
        [current.id],
      );
      await advance(client, run, current.index, now, stepDefs, orderedIndexes);
      await client.query("COMMIT");
      return;
    }
    if (account.status === "rate_limited") {
      // Defer: the step stays pending until the account is online again.
      await client.query(
        "UPDATE sequence_run_steps SET deferred_until=$2 WHERE id=$1",
        [current.id, account.rate_limited_until ?? new Date(now.getTime() + 1000)],
      );
      await client.query("UPDATE sequence_runs SET lease_until=NULL WHERE id=$1", [runId]);
      await client.query("COMMIT");
      return;
    }

    const clientMsgId = crypto.randomUUID();
    const { clientMsgId: mid } = await enqueueSend(client, {
      groupId: run.group_id,
      accountId: account.account_id,
      text: current.resolved_text ?? "",
      sequenceRunStepId: current.id,
      clientMsgId,
    });
    await client.query(
      "UPDATE sequence_run_steps SET status='accepted', client_msg_id=$3, account_id=$4 WHERE run_id=$1 AND index=$2",
      [runId, current.index, mid, account.account_id],
    );
    await emitWs(client, "sequence_run", {
      runId: run.id,
      groupId: run.group_id,
      status: "running",
      currentStepIndex: current.index,
    });
    await client.query("UPDATE sequence_runs SET lease_until=NULL WHERE id=$1", [runId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Watches the current step's message; advances on terminal delivery states. */
async function watchAccepted(
  ctx: AppContext,
  run: RunRow,
  step: StepRow,
  stepDefs: Map<number, SequenceStepDef>,
  orderedIndexes: number[],
): Promise<void> {
  if (!step.client_msg_id) return;
  const { rows } = await ctx.pool.query<{
    delivery_status: string | null;
    fail_code: string | null;
    sent_at: Date;
  }>("SELECT delivery_status, fail_code, sent_at FROM messages WHERE client_msg_id=$1", [
    step.client_msg_id,
  ]);
  const msg = rows[0];
  if (!msg) return;
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM sequence_runs WHERE id=$1 FOR UPDATE", [run.id]);
    if (msg.delivery_status === "sent") {
      await client.query(
        "UPDATE sequence_run_steps SET status='sent', sent_at=$3 WHERE run_id=$1 AND index=$2",
        [run.id, step.index, msg.sent_at],
      );
      await advance(client, run, step.index, msg.sent_at, stepDefs, orderedIndexes);
    } else if (msg.delivery_status === "failed") {
      await client.query(
        "UPDATE sequence_run_steps SET status='failed', sent_at=now() WHERE run_id=$1 AND index=$2",
        [run.id, step.index],
      );
      await advance(client, run, step.index, new Date(), stepDefs, orderedIndexes);
    } else if (msg.delivery_status === "cancelled") {
      await client.query(
        "UPDATE sequence_run_steps SET status='skipped', sent_at=now() WHERE run_id=$1 AND index=$2 AND status='accepted'",
        [run.id, step.index],
      );
      await advance(client, run, step.index, new Date(), stepDefs, orderedIndexes);
    } else {
      // queued/sending/accepted/unknown: keep waiting (rate-limited accounts
      // defer naturally since the message sits queued until the window ends).
      // Hold the lease briefly so the scheduler doesn't spin re-claiming.
      await client.query(
        "UPDATE sequence_runs SET lease_until=now() + interval '500 milliseconds' WHERE id=$1",
        [run.id],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Claims one running run (SKIP LOCKED + lease) and performs one scheduler step. */
export async function runSequenceStepOnce(ctx: AppContext): Promise<boolean> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `UPDATE sequence_runs
        SET lease_until = now() + interval '15 seconds'
      WHERE id = (
        SELECT r.id FROM sequence_runs r
        JOIN sequence_run_steps s ON s.run_id = r.id AND s.index = r.current_step_index
        WHERE r.status = 'running'
          AND (r.lease_until IS NULL OR r.lease_until < now())
          AND (s.status <> 'pending'
               OR ((s.scheduled_at IS NULL OR s.scheduled_at <= now())
                   AND (s.deferred_until IS NULL OR s.deferred_until <= now())))
        ORDER BY r.created_at
        FOR UPDATE OF r SKIP LOCKED LIMIT 1
      ) RETURNING id`,
  );
  if (!rows[0]) return false;
  const runId = rows[0].id;
  try {
    // Peek at the current step: if it is 'accepted', watch the message; if
    // terminal/advanced externally, tickSequenceRun handles advancing.
    const { rows: peek } = await ctx.pool.query<RunRow & { step_status?: string }>(
      `SELECT r.*, s.status AS step_status, s.id AS step_pk, s.client_msg_id AS step_client_msg_id
         FROM sequence_runs r LEFT JOIN sequence_run_steps s
           ON s.run_id = r.id AND s.index = r.current_step_index
        WHERE r.id=$1`,
      [runId],
    );
    const run = peek[0] as (RunRow & {
      step_status?: string;
      step_pk?: string;
      step_client_msg_id?: string;
    }) | undefined;
    if (run && run.step_status === "accepted") {
      const { rows: seqs } = await ctx.pool.query<{ steps: SequenceStepDef[] }>(
        "SELECT steps FROM sequences WHERE id=$1",
        [run.sequence_id],
      );
      const { rows: steps } = await ctx.pool.query<StepRow>(
        "SELECT * FROM sequence_run_steps WHERE run_id=$1 ORDER BY index",
        [runId],
      );
      await watchAccepted(
        ctx,
        run,
        steps.find((s) => s.id === run.step_pk)!,
        new Map((seqs[0]?.steps ?? []).map((s) => [s.index, s])),
        steps.map((s) => s.index),
      );
    } else {
      await tickSequenceRun(ctx, runId);
    }
  } catch (err) {
    await ctx.pool
      .query("UPDATE sequence_runs SET lease_until=NULL WHERE id=$1 AND status='running'", [runId])
      .catch(() => {});
    ctx.log.error({ err, runId }, "sequence step failed");
  }
  return true;
}
