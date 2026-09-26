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
  sender_account_id: string | null;
  resend_count: number;
  first_404_at: Date | null;
  unknown_since: Date;
  account_status: string | null;
}

function toDate(sentAt: number | string): Date | null {
  const t = typeof sentAt === "number" ? sentAt : Number(sentAt);
  if (Number.isFinite(t)) return new Date(t);
  const parsed = new Date(sentAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function reconcilerTick(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.pool.query<UnknownRow>(
    `SELECT m.id, m.group_id, g.gateway_group_id, m.client_msg_id, m.msg_id,
            m.resend_count, m.first_404_at, m.unknown_since,
            m.sender_account_id, a.status AS account_status
       FROM messages m
       JOIN groups g ON g.id = m.group_id
       LEFT JOIN accounts a ON a.id = m.sender_account_id
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
  let probe: { msgId: string; sentAt: number | string } | null = null;
  try {
    probe = await ctx.gateway.messageByClientId(row.gateway_group_id, row.client_msg_id);
  } catch (err) {
    if (err instanceof GatewayError && err.status === 404) {
      // Confirmed absence below.
    } else {
      // 503 / network error: probe inconclusive, try again next tick.
      return;
    }
  }

  if (probe) {
    const status = row.msg_id ? "sent" : "accepted";
    const landedAt = toDate(probe.sentAt);
    await ctx.pool.query(
      `UPDATE messages
          SET delivery_status = $2,
              msg_id = COALESCE(msg_id, $3),
              sent_at = COALESCE($4::timestamptz, sent_at),
              unknown_since = NULL, first_404_at = NULL
        WHERE id = $1`,
      [row.id, status, probe.msgId, landedAt],
    );
    return;
  }

  // 404: record the first confirmed negative probe (observability only).
  await ctx.pool.query(
    "UPDATE messages SET first_404_at = COALESCE(first_404_at, now()) WHERE id = $1",
    [row.id],
  );

  // The gateway guarantees a send lands within ~2s of a 504. unknown_since
  // anchors that window: once it has fully elapsed AND the probe still says
  // 404, the original send is confirmed missing. Once that is true a single
  // fresh 404 suffices — waiting for another full window after a gateway
  // outage only delays the resolution past the spec's 2s bound (E5).
  if (Date.now() - row.unknown_since.getTime() < CONFIRM_MISSING_MS) {
    return;
  }

  if (row.account_status === "suspended" || row.account_status === "session_expired") {
    // Sender went terminal: never resend; the message cannot be delivered.
    await ctx.pool.query(
      `UPDATE messages
          SET delivery_status='cancelled', fail_code='ACCOUNT_TERMINAL',
              unknown_since=NULL, first_404_at=NULL
        WHERE id=$1`,
      [row.id],
    );
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
