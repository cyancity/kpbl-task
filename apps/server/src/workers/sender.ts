import pg from "pg";
import type { AppContext } from "../context.js";
import { transitionAccountTx, enterTerminalTx } from "../domain/accounts/service.js";
import { markGroupUnreachable } from "../domain/groups/state.js";
import { emitWs } from "../ws/emit.js";
import { GatewayError } from "../gateway/client.js";
import { runLoop, type WorkerHandle } from "./loop.js";

const STALE_SENDING_MS = 10_000;

interface ClaimedRow {
  id: string;
  group_id: string;
  gateway_group_id: string;
  client_msg_id: string;
  sender_account_id: string;
  sender_platform_user_id: string | null;
  text: string | null;
}

/** Recover rows stuck in `sending` from a crash: they become `unknown`. */
async function recoverStaleSending(client: pg.PoolClient): Promise<void> {
  await client.query(
    `UPDATE messages
        SET delivery_status = 'unknown', unknown_since = now(), sending_since = NULL
      WHERE delivery_status = 'sending'
        AND sending_since < now() - ($1 || ' milliseconds')::interval`,
    [String(STALE_SENDING_MS)],
  );
}

async function claimOne(client: pg.PoolClient): Promise<ClaimedRow | null> {
  const { rows } = await client.query<ClaimedRow>(
    `UPDATE messages
        SET delivery_status = 'sending', sending_since = now()
      WHERE id = (
        SELECT m.id FROM messages m
        JOIN accounts a ON a.id = m.sender_account_id
        WHERE m.delivery_status = 'queued'
          AND a.status = 'online'
          AND NOT EXISTS (
            SELECT 1 FROM messages s
            WHERE s.sender_account_id = m.sender_account_id
              AND s.delivery_status = 'sending'
          )
        ORDER BY m.created_at ASC, m.id ASC
        FOR UPDATE OF m SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, group_id, client_msg_id, sender_account_id, sender_platform_user_id, text,
        (SELECT gateway_group_id FROM groups WHERE id = messages.group_id) AS gateway_group_id`,
  );
  return rows[0] ?? null;
}

async function applyOutcome(
  ctx: AppContext,
  msg: ClaimedRow,
  fn: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM messages WHERE id = $1 FOR UPDATE", [msg.id]);
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    ctx.log.warn({ err, msgId: msg.id }, "send outcome apply failed");
  } finally {
    client.release();
  }
}

async function processOne(ctx: AppContext, msg: ClaimedRow): Promise<void> {
  try {
    await ctx.gateway.send(
      msg.gateway_group_id,
      msg.sender_account_id,
      msg.client_msg_id,
      msg.text ?? "",
    );
  } catch (err) {
    if (err instanceof GatewayError) {
      await handleGatewayError(ctx, msg, err);
    } else {
      // Network-level failure: result unknown, same as NETWORK_TIMEOUT.
      await applyOutcome(ctx, msg, async (client) => {
        await client.query(
          `UPDATE messages SET delivery_status='unknown', unknown_since=now(), sending_since=NULL WHERE id=$1`,
          [msg.id],
        );
      });
    }
    return;
  }
  // 202 accepted
  await applyOutcome(ctx, msg, async (client) => {
    await client.query(
      `UPDATE messages
          SET delivery_status='accepted', accepted_at=now(), sending_since=NULL
        WHERE id=$1`,
      [msg.id],
    );
    await emitWs(client, "message", {
      groupId: msg.group_id,
      msgId: null,
      clientMsgId: msg.client_msg_id,
      isOwn: true,
      deliveryStatus: "accepted",
    });
  });
}

async function handleGatewayError(
  ctx: AppContext,
  msg: ClaimedRow,
  err: GatewayError,
): Promise<void> {
  const code = err.code;
  await applyOutcome(ctx, msg, async (client) => {
    switch (code) {
      case "RATE_LIMITED": {
        const retryAfterSeconds = Number(
          (err.body as { error?: { retryAfterSeconds?: number } })?.error?.retryAfterSeconds ??
            (err.body as { retryAfterSeconds?: number })?.retryAfterSeconds ??
            5,
        );
        await client.query(
          `UPDATE messages SET delivery_status='queued', sending_since=NULL WHERE id=$1`,
          [msg.id],
        );
        const { rows } = await client.query<{ status: string }>(
          "SELECT status FROM accounts WHERE id=$1 FOR UPDATE",
          [msg.sender_account_id],
        );
        if (rows[0]?.status === "online") {
          await transitionAccountTx(client, {
            accountId: msg.sender_account_id,
            to: "rate_limited",
            expectedFrom: "online",
            source: "gateway",
            rateLimitedUntil: new Date(Date.now() + retryAfterSeconds * 1000),
          });
        } else if (rows[0]?.status === "rate_limited") {
          // Refreshing rate_limited_until is not a transition.
          await client.query("UPDATE accounts SET rate_limited_until=$2 WHERE id=$1", [
            msg.sender_account_id,
            new Date(Date.now() + retryAfterSeconds * 1000),
          ]);
        }
        break;
      }
      case "ACCOUNT_SUSPENDED":
      case "SESSION_EXPIRED": {
        // Cascade only cancels `queued` rows; this one was `sending`.
        await client.query(
          `UPDATE messages SET delivery_status='cancelled', fail_code='ACCOUNT_TERMINAL', sending_since=NULL WHERE id=$1`,
          [msg.id],
        );
        await enterTerminalTx(
          client,
          msg.sender_account_id,
          code === "ACCOUNT_SUSPENDED" ? "suspended" : "session_expired",
        );
        break;
      }
      case "GROUP_WRITE_FORBIDDEN": {
        await client.query(
          `UPDATE messages SET delivery_status='failed', fail_code='GROUP_WRITE_FORBIDDEN', sending_since=NULL WHERE id=$1`,
          [msg.id],
        );
        await markGroupUnreachable(client, msg.group_id);
        await client.query(
          `UPDATE messages SET delivery_status='failed', fail_code='GROUP_UNREACHABLE', sending_since=NULL
           WHERE group_id=$1 AND delivery_status IN ('queued','sending','unknown')`,
          [msg.group_id],
        );
        break;
      }
      case "SENDER_NOT_IN_GROUP":
      case "ACCOUNT_OFFLINE": {
        await client.query(
          `UPDATE messages SET delivery_status='failed', fail_code=$2, sending_since=NULL WHERE id=$1`,
          [msg.id, code],
        );
        break;
      }
      default: {
        // NETWORK_TIMEOUT, 5xx and anything unexpected: result unknown.
        await client.query(
          `UPDATE messages SET delivery_status='unknown', unknown_since=now(), sending_since=NULL WHERE id=$1`,
          [msg.id],
        );
      }
    }
  });
}

export async function senderTick(ctx: AppContext): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await recoverStaleSending(client);
  } finally {
    client.release();
  }
  for (;;) {
    let msg: ClaimedRow | null = null;
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      msg = await claimOne(c);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    if (!msg) return;
    await processOne(ctx, msg);
  }
}

export function startSenderWorker(ctx: AppContext, intervalMs = 200): WorkerHandle {
  return runLoop("sender", intervalMs, () => senderTick(ctx), ctx.log);
}
