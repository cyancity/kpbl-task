import pg from "pg";
import type { AppContext } from "../../context.js";
import { GatewayError } from "../../gateway/client.js";
import { emitWs } from "../../ws/emit.js";

export interface JobError {
  step: string;
  code: string;
}

export interface JobRow {
  id: string;
  kind: "create_group" | "leave_all";
  group_id: string;
  status: "running" | "finished" | "failed";
  state: Record<string, unknown>;
  errors: JobError[];
}

export interface CreateGroupState {
  phase: "create" | "invite" | "join" | "await" | "promote" | "done";
  gatewayGroupId?: string;
  inviteLink?: string;
  readyAt?: number;
  inviteRenewals: number;
  memberAccountIds: string[];
  members: Record<
    string,
    { status: "pending" | "requested" | "joined" | "failed"; requestedAt?: number }
  >;
  promoteCalls: number;
}

export interface LeaveAllState {
  phase: "leave_members" | "await" | "leave_owner" | "reconcile" | "done";
  gatewayGroupId: string;
  creatorAccountId: string;
  leaveIssued: Record<string, "ok" | "error">;
  deadline?: number;
}

const RETRY_MS = 300;
const LEAVE_WAIT_MS = 5000;

function gwCode(err: unknown): string {
  if (err instanceof GatewayError) return err.code;
  // Not a gateway failure at all (e.g. a local DB constraint violation):
  // do not disguise it as NETWORK_TIMEOUT.
  return "INTERNAL";
}

async function finishJob(
  ctx: AppContext,
  job: JobRow,
  errors: JobError[],
  extra?: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const status = errors.length ? "failed" : "finished";
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE jobs SET status=$2, errors=$3, updated_at=now(), lease_until=NULL WHERE id=$1",
      [job.id, status, JSON.stringify(errors)],
    );
    if (extra) await extra(client);
    await emitWs(client, "job", { jobId: job.id, kind: job.kind, status, groupId: job.group_id });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mid-step checkpoint: persists state without touching the lease. Unlike
 * saveState (which ends a step by releasing the claim), this keeps the job
 * locked so no second instance can step it concurrently — it exists purely to
 * make a side-effect's intent durable before the call goes out.
 */
async function persistJobState(ctx: AppContext, jobId: string, state: unknown): Promise<void> {
  await ctx.pool.query("UPDATE jobs SET state=$2, updated_at=now() WHERE id=$1", [
    jobId,
    JSON.stringify(state),
  ]);
}

async function saveState(
  ctx: AppContext,
  jobId: string,
  state: unknown,
  errors: JobError[],
  nextRunAt: Date | null,
): Promise<void> {
  await ctx.pool.query(
    "UPDATE jobs SET state=$2, errors=$3, next_run_at=$4, updated_at=now(), lease_until=NULL WHERE id=$1",
    [jobId, JSON.stringify(state), JSON.stringify(errors), nextRunAt],
  );
}

// ---------------------------------------------------------------- create_group

export function initialCreateGroupState(memberAccountIds: string[]): CreateGroupState {
  return {
    phase: "create",
    inviteRenewals: 0,
    memberAccountIds,
    members: Object.fromEntries(memberAccountIds.map((id) => [id, { status: "pending" }])),
    promoteCalls: 0,
  };
}

async function stepCreateGroup(ctx: AppContext, job: JobRow): Promise<void> {
  const state = structuredClone(job.state) as unknown as CreateGroupState;
  const errors = structuredClone(job.errors) as JobError[];
  const now = Date.now();

  switch (state.phase) {
    case "create": {
      try {
        if (!state.gatewayGroupId) {
          const { groupId } = await ctx.gateway.createGroup(
            job.state.creatorAccountId as string,
          );
          state.gatewayGroupId = groupId;
          // Persist the gateway handle first: a crash after createGroup
          // returns but before the state lands would otherwise create a
          // duplicate gateway group on resume.
          await saveState(ctx, job.id, state, errors, null);
        }
        const client = await ctx.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "UPDATE groups SET gateway_group_id=$2, status='active' WHERE id=$1",
            [job.group_id, state.gatewayGroupId],
          );
          const { rows: acc } = await client.query<{ platform_user_id: string }>(
            "SELECT platform_user_id FROM accounts WHERE id=$1",
            [job.state.creatorAccountId],
          );
          await client.query(
            `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
             VALUES ($1,$2,$3,'creator') ON CONFLICT DO NOTHING`,
            [job.group_id, job.state.creatorAccountId, acc[0]!.platform_user_id],
          );
          await emitWs(client, "group_status_changed", {
            groupId: job.group_id,
            status: "active",
          });
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        state.phase = "invite";
      } catch (err) {
        ctx.log.warn({ err, jobId: job.id, step: "create" }, "create_group step failed");
        errors.push({ step: "create", code: gwCode(err) });
        return finishJob(ctx, job, errors);
      }
      return saveState(ctx, job.id, state, errors, null);
    }

    case "invite": {
      try {
        const res = await ctx.gateway.invite(state.gatewayGroupId!);
        state.inviteLink = res.inviteLink;
        state.readyAt = now + res.readyAfterMs;
        state.phase = "join";
      } catch (err) {
        errors.push({ step: "invite", code: gwCode(err) });
        return finishJob(ctx, job, errors);
      }
      return saveState(ctx, job.id, state, errors, null);
    }

    case "join": {
      const pending = state.memberAccountIds.filter(
        (id) => state.members[id]!.status === "pending",
      );
      if (!pending.length) {
        state.phase = "await";
        return saveState(ctx, job.id, state, errors, null);
      }
      if (state.readyAt && now < state.readyAt) {
        return saveState(ctx, job.id, state, errors, new Date(state.readyAt));
      }
      let renewInvite = false;
      for (const accountId of pending) {
        try {
          await ctx.gateway.join(state.gatewayGroupId!, accountId, state.inviteLink!);
          state.members[accountId] = { status: "requested", requestedAt: now };
        } catch (err) {
          const code = gwCode(err);
          if (code === "ALREADY_MEMBER") {
            const client = await ctx.pool.connect();
            try {
              await client.query("BEGIN");
              const { rows: acc } = await client.query<{ platform_user_id: string }>(
                "SELECT platform_user_id FROM accounts WHERE id=$1",
                [accountId],
              );
              await client.query(
                `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
                 VALUES ($1,$2,$3,'member') ON CONFLICT (group_id, platform_user_id) DO NOTHING`,
                [job.group_id, accountId, acc[0]!.platform_user_id],
              );
              await client.query("COMMIT");
            } catch (e) {
              await client.query("ROLLBACK").catch(() => {});
              throw e;
            } finally {
              client.release();
            }
            state.members[accountId] = { status: "joined" };
          } else if (code === "INVITE_NOT_READY") {
            return saveState(
              ctx,
              job.id,
              state,
              errors,
              new Date(Math.max(now + 500, state.readyAt ?? now + 500)),
            );
          } else if (code === "INVITE_EXPIRED") {
            if (state.inviteRenewals < 1) {
              renewInvite = true;
              break;
            }
            state.members[accountId] = { status: "failed" };
            errors.push({ step: `join:${accountId}`, code: "INVITE_EXPIRED" });
          } else {
            state.members[accountId] = { status: "failed" };
            errors.push({ step: `join:${accountId}`, code });
          }
        }
      }
      if (renewInvite) {
        state.inviteRenewals += 1;
        state.phase = "invite";
        return saveState(ctx, job.id, state, errors, null);
      }
      state.phase = "await";
      return saveState(ctx, job.id, state, errors, null);
    }

    case "await": {
      const { rows } = await ctx.pool.query<{ account_id: string }>(
        "SELECT account_id FROM group_members WHERE group_id=$1 AND account_id = ANY($2::text[])",
        [job.group_id, state.memberAccountIds],
      );
      const joined = new Set(rows.map((r) => r.account_id));
      for (const id of state.memberAccountIds) {
        const m = state.members[id]!;
        if (m.status === "joined" || m.status === "failed") continue;
        if (joined.has(id)) {
          m.status = "joined";
          continue;
        }
        if (m.requestedAt && now - m.requestedAt > ctx.config.joinTimeoutMs) {
          m.status = "failed";
          errors.push({ step: `join:${id}`, code: "JOIN_TIMEOUT" });
        }
      }
      if (
        state.memberAccountIds.every((id) =>
          ["joined", "failed"].includes(state.members[id]!.status),
        )
      ) {
        state.phase = "promote";
        return saveState(ctx, job.id, state, errors, null);
      }
      return saveState(ctx, job.id, state, errors, new Date(now + RETRY_MS));
    }

    case "promote": {
      const target = state.memberAccountIds[0]!;
      if (state.members[target]!.status !== "joined") {
        state.phase = "done";
        return saveState(ctx, job.id, state, errors, null);
      }
      if (state.promoteCalls >= 2) {
        // Both calls were already consumed; a previous attempt crashed with the
        // result unknown. Calling again would break the ≤2 total-call contract.
        errors.push({ step: "promote", code: "RESULT_UNKNOWN" });
        state.phase = "done";
        return saveState(ctx, job.id, state, errors, null);
      }
      state.promoteCalls += 1;
      // Count the call before making it: a crash between the gateway call and
      // saveState would otherwise replay with a stale counter and exceed the
      // two-call budget.
      await persistJobState(ctx, job.id, state);
      try {
        await ctx.gateway.promote(
          state.gatewayGroupId!,
          job.state.creatorAccountId as string,
          target,
        );
        await ctx.pool.query(
          "UPDATE group_members SET role='admin' WHERE group_id=$1 AND account_id=$2",
          [job.group_id, target],
        );
      } catch (err) {
        const code = gwCode(err);
        if (code === "NOT_MEMBER_YET" && state.promoteCalls < 2) {
          return saveState(ctx, job.id, state, errors, new Date(now + RETRY_MS));
        }
        errors.push({ step: "promote", code });
      }
      state.phase = "done";
      return saveState(ctx, job.id, state, errors, null);
    }

    case "done":
      return finishJob(ctx, job, errors);
  }
}

// ---------------------------------------------------------------- leave_all

export function initialLeaveAllState(
  gatewayGroupId: string,
  creatorAccountId: string,
): LeaveAllState {
  return { phase: "leave_members", gatewayGroupId, creatorAccountId, leaveIssued: {} };
}

async function stepLeaveAll(ctx: AppContext, job: JobRow): Promise<void> {
  const state = structuredClone(job.state) as unknown as LeaveAllState;
  const errors = structuredClone(job.errors) as JobError[];
  const now = Date.now();

  switch (state.phase) {
    case "leave_members": {
      const { rows } = await ctx.pool.query<{ account_id: string }>(
        `SELECT DISTINCT account_id FROM group_members
          WHERE group_id=$1 AND account_id IS NOT NULL AND account_id <> $2 AND role <> 'creator'`,
        [job.group_id, state.creatorAccountId],
      );
      for (const { account_id } of rows) {
        if (state.leaveIssued[account_id]) continue;
        try {
          await ctx.gateway.leave(state.gatewayGroupId, account_id);
          state.leaveIssued[account_id] = "ok";
        } catch (err) {
          state.leaveIssued[account_id] = "error";
          errors.push({ step: `leave:${account_id}`, code: gwCode(err) });
        }
        // Persist per member so a crash mid-loop does not re-issue leaves.
        await persistJobState(ctx, job.id, state);
      }
      state.deadline = now + LEAVE_WAIT_MS;
      state.phase = "await";
      return saveState(ctx, job.id, state, errors, null);
    }

    case "await": {
      const { rows } = await ctx.pool.query<{ account_id: string }>(
        `SELECT DISTINCT account_id FROM group_members
          WHERE group_id=$1 AND account_id IS NOT NULL AND account_id <> $2`,
        [job.group_id, state.creatorAccountId],
      );
      const stillThere = rows.filter(
        (r) => state.leaveIssued[r.account_id] === "ok",
      );
      if (stillThere.length === 0 || (state.deadline && now > state.deadline)) {
        state.phase = "leave_owner";
        return saveState(ctx, job.id, state, errors, null);
      }
      return saveState(ctx, job.id, state, errors, new Date(now + RETRY_MS));
    }

    case "leave_owner": {
      if (!errors.length && !state.leaveIssued[state.creatorAccountId]) {
        try {
          await ctx.gateway.leave(state.gatewayGroupId, state.creatorAccountId);
          state.leaveIssued[state.creatorAccountId] = "ok";
        } catch (err) {
          state.leaveIssued[state.creatorAccountId] = "error";
          errors.push({ step: `leave:${state.creatorAccountId}`, code: gwCode(err) });
        }
      }
      state.phase = "reconcile";
      return saveState(ctx, job.id, state, errors, null);
    }

    case "reconcile": {
      try {
        const gatewayMembers = await ctx.gateway.members(state.gatewayGroupId);
        const gatewayIds = new Set(gatewayMembers.map((m) => m.platformUserId));
        const client = await ctx.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM group_members WHERE group_id=$1 AND platform_user_id <> ALL($2::text[])",
            [job.group_id, [...gatewayIds]],
          );
          const { rows: ours } = await client.query<{ platform_user_id: string }>(
            "SELECT platform_user_id FROM group_members WHERE group_id=$1",
            [job.group_id],
          );
          const oursSet = new Set(ours.map((r) => r.platform_user_id));
          for (const pu of gatewayIds) {
            if (oursSet.has(pu)) continue;
            const { rows: acc } = await client.query<{ id: string }>(
              "SELECT id FROM accounts WHERE platform_user_id=$1",
              [pu],
            );
            await client.query(
              `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
               VALUES ($1,$2,$3,'member') ON CONFLICT (group_id, platform_user_id) DO NOTHING`,
              [job.group_id, acc[0]?.id ?? null, pu],
            );
          }
          if (!errors.length) {
            await client.query("UPDATE groups SET status='left' WHERE id=$1", [job.group_id]);
            await emitWs(client, "group_status_changed", {
              groupId: job.group_id,
              status: "left",
            });
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        errors.push({ step: "leave:reconcile", code: gwCode(err) });
      }
      state.phase = "done";
      return saveState(ctx, job.id, state, errors, null);
    }

    case "done":
      return finishJob(ctx, job, errors);
  }
}

/** Executes one state-machine step for a job row (already claimed / locked). */
export async function runJobStep(ctx: AppContext, jobId: string): Promise<void> {
  const { rows } = await ctx.pool.query<JobRow>(
    "SELECT id, kind, group_id, status, state, errors FROM jobs WHERE id=$1",
    [jobId],
  );
  const job = rows[0];
  if (!job || job.status !== "running") return;
  if (job.kind === "create_group") return stepCreateGroup(ctx, job);
  return stepLeaveAll(ctx, job);
}

/** Claims one runnable job (SKIP LOCKED + lease) and executes a single step. */
export async function runJobOnce(ctx: AppContext): Promise<boolean> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `UPDATE jobs SET lease_until = now() + interval '15 seconds', updated_at = now()
      WHERE id = (
        SELECT id FROM jobs
         WHERE status='running'
           AND (next_run_at IS NULL OR next_run_at <= now())
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id`,
  );
  const job = rows[0];
  if (!job) return false;
  await runJobStep(ctx, job.id);
  return true;
}
