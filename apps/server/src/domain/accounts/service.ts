import pg from "pg";
import type { AccountStatus } from "@gmp/shared";
import { AppError } from "../../errors.js";
import { emitWs } from "../../ws/emit.js";
import { canTransition, isTerminal } from "./transitions.js";
import { GatewayClient, GatewayError } from "../../gateway/client.js";

interface TransitionOptions {
  accountId: string;
  to: AccountStatus;
  expectedFrom: AccountStatus;
  source: "operator" | "gateway" | "system";
  platformUserId?: string | null;
  rateLimitedUntil?: Date | null;
}

export interface AccountRow {
  id: string;
  status: AccountStatus;
  platform_user_id: string | null;
  rate_limited_until: Date | null;
  version: number;
}

async function lockAccount(client: pg.PoolClient, accountId: string): Promise<AccountRow | null> {
  const { rows } = await client.query<AccountRow>(
    "SELECT id, status, platform_user_id, rate_limited_until, version FROM accounts WHERE id = $1 FOR UPDATE",
    [accountId],
  );
  return rows[0] ?? null;
}

export async function transitionAccount(
  pool: pg.Pool,
  gateway: GatewayClient,
  opts: TransitionOptions,
  log?: { warn: (obj: object, msg: string) => void },
): Promise<AccountRow> {
  const { accountId, to, expectedFrom } = opts;
  const client = await pool.connect();
  let result: AccountRow | undefined;
  try {
    await client.query("BEGIN");
    const current = await lockAccount(client, accountId);
    if (!current) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", `account ${accountId} not found`);
    }
    if (!canTransition(expectedFrom, to)) {
      throw new AppError(
        409,
        "ILLEGAL_TRANSITION",
        `transition ${expectedFrom} -> ${to} is not allowed`,
      );
    }
    if (current.status !== expectedFrom) {
      throw new AppError(
        409,
        "CAS_CONFLICT",
        `account ${accountId} is ${current.status}, expected ${expectedFrom}`,
        { currentStatus: current.status, expectedFrom },
      );
    }

    const terminal = isTerminal(to);
    const { rows } = await client.query<AccountRow>(
      `UPDATE accounts
         SET status = $2,
             version = version + 1,
             updated_at = now(),
             platform_user_id = COALESCE($4, platform_user_id),
             rate_limited_until = COALESCE($5, rate_limited_until)
       WHERE id = $1 AND status = $3
       RETURNING id, status, platform_user_id, rate_limited_until, version`,
      [accountId, to, expectedFrom, opts.platformUserId ?? null, opts.rateLimitedUntil ?? null],
    );
    const updated = rows[0];
    if (!updated) {
      throw new AppError(409, "CAS_CONFLICT", `account ${accountId} changed concurrently`);
    }

    if (terminal) {
      await client.query("DELETE FROM group_members WHERE account_id = $1", [accountId]);
      const { rows: cancelled } = await client.query<{ client_msg_id: string }>(
        `UPDATE messages
            SET delivery_status = 'cancelled', fail_code = 'ACCOUNT_TERMINAL'
          WHERE sender_account_id = $1 AND delivery_status = 'queued'
          RETURNING client_msg_id`,
        [accountId],
      );
      const clientMsgIds = cancelled.map((r) => r.client_msg_id).filter(Boolean);
      if (clientMsgIds.length) {
        await client.query(
          `UPDATE sequence_run_steps
              SET status = 'skipped', sent_at = now()
            WHERE client_msg_id = ANY($1::uuid[]) AND status = 'pending'`,
          [clientMsgIds],
        );
      }
    }

    await emitWs(client, "account_status_changed", { accountId, from: expectedFrom, to });
    if (terminal) {
      await emitWs(client, "account_terminal", { accountId, status: to });
    }

    await client.query("COMMIT");
    result = updated;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (to === "idle" || to === "disconnected") {
    try {
      await gateway.disconnect(accountId);
    } catch (err) {
      log?.warn({ err, accountId }, "gateway disconnect failed");
    }
  }
  return result;
}

async function getAccountStatus(pool: pg.Pool, accountId: string): Promise<AccountStatus | null> {
  const { rows } = await pool.query<{ status: AccountStatus }>(
    "SELECT status FROM accounts WHERE id = $1",
    [accountId],
  );
  return rows[0]?.status ?? null;
}

/** Idempotent entry into a terminal status shared by all sources. */
export async function enterTerminal(
  pool: pg.Pool,
  gateway: GatewayClient,
  accountId: string,
  status: "suspended" | "session_expired",
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getAccountStatus(pool, accountId);
    if (current === null) {
      throw new AppError(404, "ACCOUNT_NOT_FOUND", `account ${accountId} not found`);
    }
    if (isTerminal(current)) return; // already terminal (this or the other one)
    try {
      await transitionAccount(pool, gateway, {
        accountId,
        to: status,
        expectedFrom: current,
        source: "system",
      });
      return;
    } catch (err) {
      if (err instanceof AppError && err.code === "CAS_CONFLICT") continue;
      throw err;
    }
  }
  throw new AppError(409, "CAS_CONFLICT", `account ${accountId} kept changing concurrently`);
}

export async function connectAccount(
  pool: pg.Pool,
  gateway: GatewayClient,
  accountId: string,
): Promise<{ status: AccountStatus; platformUserId: string }> {
  const current = await getAccountStatus(pool, accountId);
  if (current === null) {
    throw new AppError(404, "ACCOUNT_NOT_FOUND", `account ${accountId} not found`);
  }
  if (current !== "idle" && current !== "disconnected") {
    throw new AppError(
      409,
      "ILLEGAL_TRANSITION",
      `account ${accountId} cannot connect from ${current}`,
    );
  }

  let platformUserId: string;
  try {
    const res = await gateway.connect(accountId);
    platformUserId = res.platformUserId;
  } catch (err) {
    if (err instanceof GatewayError && err.code === "ACCOUNT_SUSPENDED") {
      await enterTerminal(pool, gateway, accountId, "suspended");
      throw new AppError(409, "ACCOUNT_UNAVAILABLE", `account ${accountId} is suspended`);
    }
    if (err instanceof GatewayError && err.code === "SESSION_EXPIRED") {
      await enterTerminal(pool, gateway, accountId, "session_expired");
      throw new AppError(409, "ACCOUNT_UNAVAILABLE", `account ${accountId} session expired`);
    }
    throw err;
  }

  const updated = await transitionAccount(pool, gateway, {
    accountId,
    to: "online",
    expectedFrom: current,
    source: "operator",
    platformUserId,
  });
  return { status: updated.status, platformUserId };
}
