import type { AppContext } from "../context.js";
import { GatewayError } from "../gateway/client.js";
import { runLoop, type WorkerHandle } from "./loop.js";

const CONFIRM_MISSING_MS = 2000;
const BATCH = 20;

interface UnknownRow {
  id: string;
  group_id: string;
  gateway_group_id: string;
  client_msg_id: string;
  msg_id: string | null;
  resend_count: number;
  first_404_at: Date | null;
  unknown_since: Date;
}

export async function reconcilerTick(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.pool.query<UnknownRow>(
    `SELECT m.id, m.group_id, g.gateway_group_id, m.client_msg_id, m.msg_id,
            m.resend_count, m.first_404_at, m.unknown_since
       FROM messages m
       JOIN groups g ON g.id = m.group_id
      WHERE m.delivery_status = 'unknown'
      ORDER BY m.unknown_since ASC
      LIMIT $1`,
    [BATCH],
  );
  for (const row of rows) {
    await reconcileOne(ctx, row);
  }
}

async function reconcileOne(ctx: AppContext, row: UnknownRow): Promise<void> {
  let probe: { msgId: string; sentAt: string } | null = null;
  try {
    probe = await ctx.gateway.messageByClientId(row.gateway_group_id, row.client_msg_id);
  } catch (err) {
    if (err instanceof GatewayError && err.status === 404) {
      // Confirmed absence below.
    } else {
      // 503 / network error: probe inconclusive; reset the 404 clock.
      await ctx.pool.query("UPDATE messages SET first_404_at = NULL WHERE id = $1", [row.id]);
      return;
    }
  }

  if (probe) {
    const status = row.msg_id ? "sent" : "accepted";
    await ctx.pool.query(
      `UPDATE messages
          SET delivery_status = $2,
              msg_id = COALESCE(msg_id, $3),
              sent_at = COALESCE($4::timestamptz, sent_at),
              unknown_since = NULL, first_404_at = NULL
        WHERE id = $1`,
      [row.id, status, probe.msgId, probe.sentAt],
    );
    return;
  }

  // 404: mark the first successful negative probe. A 404 only counts as
  // "confirmed not sent" once the gateway's landing window (2s after the
  // 504) has fully elapsed: anchor at BOTH unknown_since and the first
  // 404 probe after any 503-induced reset.
  const first404 = row.first_404_at ?? new Date();
  await ctx.pool.query(
    "UPDATE messages SET first_404_at = COALESCE(first_404_at, now()) WHERE id = $1",
    [row.id],
  );
  if (
    Date.now() - first404.getTime() < CONFIRM_MISSING_MS ||
    Date.now() - row.unknown_since.getTime() < CONFIRM_MISSING_MS
  ) {
    return;
  }

  if (row.resend_count === 0) {
    // Confirmed never landed: resend once with the same clientMsgId.
    await ctx.pool.query(
      `UPDATE messages
          SET delivery_status='queued', resend_count=1, unknown_since=NULL,
              first_404_at=NULL, sending_since=NULL
        WHERE id=$1`,
      [row.id],
    );
  } else {
    await ctx.pool.query(
      `UPDATE messages
          SET delivery_status='failed', fail_code='NETWORK_TIMEOUT', unknown_since=NULL
        WHERE id=$1`,
      [row.id],
    );
  }
}

export function startReconcilerWorker(ctx: AppContext, intervalMs = 250): WorkerHandle {
  return runLoop("unknown-reconciler", intervalMs, () => reconcilerTick(ctx), ctx.log);
}
