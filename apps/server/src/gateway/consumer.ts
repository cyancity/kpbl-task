import pg from "pg";
import type { AppContext } from "../context.js";
import { enterTerminalTx } from "../domain/accounts/service.js";
import { markGroupUnreachable } from "../domain/groups/state.js";
import { emitWs } from "../ws/emit.js";
import type { InboundMessageRow } from "../context.js";

interface SseEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

/** Minimal SSE frame parser fed with decoded text chunks. */
export class SseParser {
  private buffer = "";

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = this.parseFrame(frame);
      if (ev) events.push(ev);
    }
    return events;
  }

  private parseFrame(frame: string): SseEvent | null {
    let id: string | null = null;
    let type = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (id === null || !dataLines.length) return null;
    try {
      return { id: Number(id), type, data: JSON.parse(dataLines.join("\n")) };
    } catch {
      return null;
    }
  }
}

const GAP_TOLERANCE_MS = 2000;
const WATERMARK_FLUSH_MS = 500;

export interface ConsumerHandle {
  stop: () => Promise<void>;
}

export function startConsumer(ctx: AppContext): ConsumerHandle {
  const decoder = new TextDecoder();
  const processed = new Set<number>();
  let watermark: number | null = null;
  let maxSeen = 0;
  let maxSeenAt = 0;
  let stopped = false;
  let abort: AbortController | null = null;
  let firstEventSeen = false;

  const loadCursor = async () => {
    const { rows } = await ctx.pool.query<{ watermark: string }>(
      "SELECT watermark FROM gateway_cursor WHERE id = 1",
    );
    if (rows[0]) {
      watermark = Number(rows[0].watermark);
      firstEventSeen = true;
    }
  };

  const computeWatermark = (): number | null => {
    if (watermark === null) return null;
    let w = watermark;
    while (processed.has(w + 1)) {
      processed.delete(w + 1);
      w += 1;
    }
    // Out-of-order gap: if the highest id seen is stale (>2s old), assume the
    // gap ids never existed at the gateway and jump to maxSeen.
    if (w < maxSeen && Date.now() - maxSeenAt > GAP_TOLERANCE_MS) {
      w = maxSeen;
      processed.clear();
    }
    return w;
  };

  const flushWatermark = async () => {
    const w = computeWatermark();
    if (w === null || w === watermark) return;
    watermark = w;
    await ctx.pool
      .query(
        "INSERT INTO gateway_cursor (id, watermark) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET watermark = $1",
        [w],
      )
      .catch((err) => ctx.log.warn({ err }, "watermark persist failed"));
  };

  const flushTimer = setInterval(() => void flushWatermark(), WATERMARK_FLUSH_MS);
  flushTimer.unref();

  const run = async () => {
    let backoff = 200;
    while (!stopped) {
      try {
        if (watermark === null && !firstEventSeen) await loadCursor();
        const url = new URL(`${ctx.config.gatewayUrl}/events`);
        if (watermark !== null) url.searchParams.set("since", String(watermark));
        abort = new AbortController();
        const res = await fetch(url, {
          signal: abort.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`events stream HTTP ${res.status}`);
        backoff = 200;
        const parser = new SseParser();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const events = parser.feed(decoder.decode(value, { stream: true }));
          for (const ev of events) {
            await processEvent(ctx, ev);
            if (!firstEventSeen) {
              firstEventSeen = true;
              // Persist watermark just before the first event so a restart
              // backfills everything the gateway produced while we were down.
              await ctx.pool
                .query(
                  "INSERT INTO gateway_cursor (id, watermark) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
                  [ev.id - 1],
                )
                .catch(() => {});
              if (watermark === null) watermark = ev.id - 1;
            }
            if (ev.id > maxSeen) {
              maxSeen = ev.id;
              maxSeenAt = Date.now();
            }
            processed.add(ev.id);
          }
          await flushWatermark();
        }
      } catch (err) {
        if (stopped) break;
        ctx.log.warn({ err }, "event stream interrupted, reconnecting");
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 2000);
    }
  };

  const running = run();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(flushTimer);
      abort?.abort();
      await running.catch(() => {});
      await flushWatermark();
    },
  };
}

async function processEvent(ctx: AppContext, ev: SseEvent): Promise<void> {
  const client = await ctx.pool.connect();
  let inserted = false;
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      "INSERT INTO gateway_events (event_id, type, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [ev.id, ev.type, JSON.stringify(ev.data)],
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return; // duplicate
    }
    inserted = true;
    if (process.env.ENABLE_FAULT_INJECTION === "1" && ctx.faults.failNextEventHandler) {
      ctx.faults.failNextEventHandler = false;
      throw new Error("injected event handler fault");
    }
    await dispatch(ctx, client, ev);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (inserted) await deadLetter(ctx, ev, err);
    else throw err;
  } finally {
    client.release();
  }
}

async function deadLetter(ctx: AppContext, ev: SseEvent, err: unknown): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO dead_events (event_id, type, payload, error) VALUES ($1,$2,$3,$4)",
      [ev.id, ev.type, JSON.stringify(ev.data), String(err)],
    );
    await emitWs(client, "inconsistency", {
      kind: "event_processing_failed",
      ref: ev.id,
      message: String(err),
    });
    await client.query("COMMIT");
  } catch (inner) {
    await client.query("ROLLBACK").catch(() => {});
    ctx.log.warn({ inner }, "dead_events write failed");
  } finally {
    client.release();
  }
}

async function groupByGatewayId(
  client: pg.PoolClient,
  gatewayGroupId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM groups WHERE gateway_group_id = $1",
    [gatewayGroupId],
  );
  return rows[0]?.id ?? null;
}

async function dispatch(ctx: AppContext, client: pg.PoolClient, ev: SseEvent): Promise<void> {
  const d = ev.data;
  switch (ev.type) {
    case "message":
      return onMessage(ctx, client, ev);
    case "message_sent":
      return onMessageSent(ctx, client, d);
    case "message_failed":
      return onMessageFailed(ctx, client, d);
    case "member_joined":
      return onMemberJoined(ctx, client, ev);
    case "member_left":
      return onMemberLeft(ctx, client, ev);
    case "account_status":
      return onAccountStatus(ctx, client, d);
  }
}

async function onMessage(
  ctx: AppContext,
  client: pg.PoolClient,
  ev: SseEvent,
): Promise<void> {
  const d = ev.data;
  const groupId = await groupByGatewayId(client, String(d.groupId));
  if (!groupId) {
    // The event must not be silently dropped: park it in dead_events and
    // surface it so an operator can see a message arrived for a group we do
    // not know (e.g. it raced ahead of the create-group job).
    await client.query(
      "INSERT INTO dead_events (event_id, type, payload, error) VALUES ($1,$2,$3,$4)",
      [ev.id, ev.type, JSON.stringify(ev.data), "message for unknown group"],
    );
    await emitWs(client, "inconsistency", {
      kind: "unknown_group",
      ref: d.groupId,
      message: "message event for unknown group",
    });
    ctx.log.warn({ data: d }, "message event for unknown group");
    return;
  }
  const msgId = String(d.msgId);
  const { rows: existing } = await client.query(
    "SELECT id FROM messages WHERE group_id=$1 AND msg_id=$2",
    [groupId, msgId],
  );
  if (existing[0]) return; // dedupe by (groupId, msgId)

  const sender = String(d.senderPlatformUserId);
  const { rows: ownAcc } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE platform_user_id = $1",
    [sender],
  );
  const isOwn = !!ownAcc[0];
  const { rows } = await client.query<InboundMessageRow>(
    `INSERT INTO messages
       (group_id, msg_id, sender_platform_user_id, sender_account_id, is_own, text, sent_at, media_url, delivery_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, group_id, msg_id, sender_platform_user_id, text, sent_at`,
    [
      groupId,
      msgId,
      sender,
      ownAcc[0]?.id ?? null,
      isOwn,
      d.text ?? null,
      new Date(Number(d.sentAt)),
      d.mediaUrl ?? null,
      isOwn ? "sent" : null,
    ],
  );
  const row = rows[0]!;
  if (!isOwn) await ctx.hooks.onInboundMessage(client, row);
  await emitWs(client, "message", {
    groupId,
    msgId,
    isOwn,
    clientMsgId: null,
    sentAt: row.sent_at.toISOString(),
  });
}

async function onMessageSent(
  ctx: AppContext,
  client: pg.PoolClient,
  d: Record<string, unknown>,
): Promise<void> {
  const clientMsgId = String(d.clientMsgId);
  const msgId = String(d.msgId);
  const sentAt = new Date(Number(d.sentAt));
  const { rows } = await client.query<{
    id: string;
    group_id: string;
    msg_id: string | null;
  }>("SELECT id, group_id, msg_id FROM messages WHERE client_msg_id = $1 FOR UPDATE", [
    clientMsgId,
  ]);
  const row = rows[0];
  if (!row) {
    ctx.log.warn({ data: d }, "message_sent for unknown clientMsgId");
    return;
  }
  if (row.msg_id && row.msg_id !== msgId) {
    await emitWs(client, "inconsistency", {
      kind: "duplicate_delivery",
      ref: clientMsgId,
      message: `clientMsgId ${clientMsgId} landed as both ${row.msg_id} and ${msgId}`,
    });
    return;
  }
  const groupId = await groupByGatewayId(client, String(d.groupId));
  // If the own-message reflux arrived first and occupied (group,msgId), fold it
  // into the outbox row in the same transaction.
  if (groupId) {
    await client.query(
      "DELETE FROM messages WHERE group_id=$1 AND msg_id=$2 AND id <> $3 AND client_msg_id IS NULL",
      [groupId, msgId, row.id],
    );
  }
  await client.query(
    `UPDATE messages
        SET msg_id=$2, sent_at=$3, delivery_status='sent',
            unknown_since=NULL, first_404_at=NULL, sending_since=NULL,
            sender_platform_user_id=COALESCE(sender_platform_user_id, $4)
      WHERE id=$1`,
    [row.id, msgId, sentAt, d.senderPlatformUserId ?? null],
  );
  await emitWs(client, "message", {
    groupId: row.group_id,
    msgId,
    clientMsgId,
    isOwn: true,
    deliveryStatus: "sent",
    sentAt: sentAt.toISOString(),
  });
}

async function onMessageFailed(
  ctx: AppContext,
  client: pg.PoolClient,
  d: Record<string, unknown>,
): Promise<void> {
  const clientMsgId = String(d.clientMsgId);
  const code = String(d.code);
  const { rows } = await client.query<{
    id: string;
    group_id: string;
    delivery_status: string | null;
    sender_account_id: string | null;
  }>(
    "SELECT id, group_id, delivery_status, sender_account_id FROM messages WHERE client_msg_id=$1 FOR UPDATE",
    [clientMsgId],
  );
  const row = rows[0];
  if (!row) return;
  // A failure event for a message already resolved is stale ordering noise —
  // 'sent' means the gateway confirmed delivery, 'cancelled' means we already
  // gave up on it; neither may be overwritten.
  if (row.delivery_status === "sent" || row.delivery_status === "cancelled") {
    await emitWs(client, "inconsistency", {
      kind: "stale_failure",
      ref: clientMsgId,
      message: `message_failed(${code}) arrived for a message already ${row.delivery_status}`,
    });
    return;
  }
  await client.query(
    "UPDATE messages SET delivery_status='failed', fail_code=$2, sending_since=NULL WHERE id=$1",
    [row.id, code],
  );
  await emitWs(client, "message", {
    groupId: row.group_id,
    msgId: null,
    clientMsgId,
    isOwn: true,
    deliveryStatus: "failed",
    failCode: code,
  });
  if (code === "GROUP_WRITE_FORBIDDEN") {
    await markGroupUnreachable(client, row.group_id);
    await client.query(
      `UPDATE messages SET delivery_status='failed', fail_code='GROUP_UNREACHABLE', sending_since=NULL
       WHERE group_id=$1 AND delivery_status IN ('queued','sending','unknown')`,
      [row.group_id],
    );
  } else if (code === "ACCOUNT_SUSPENDED" && row.sender_account_id) {
    await enterTerminalTx(client, row.sender_account_id, "suspended");
  }
}

async function onMemberJoined(
  ctx: AppContext,
  client: pg.PoolClient,
  ev: SseEvent,
): Promise<void> {
  const d = ev.data;
  const groupId = await groupByGatewayId(client, String(d.groupId));
  if (!groupId) {
    await client.query(
      "INSERT INTO dead_events (event_id, type, payload, error) VALUES ($1,$2,$3,$4)",
      [ev.id, ev.type, JSON.stringify(ev.data), "member_joined for unknown group"],
    );
    await emitWs(client, "inconsistency", {
      kind: "unknown_group",
      ref: d.groupId,
      message: "member_joined event for unknown group",
    });
    return;
  }
  const platformUserId = String(d.platformUserId);
  const { rows: acc } = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE platform_user_id = $1",
    [platformUserId],
  );
  await client.query(
    `INSERT INTO group_members (group_id, account_id, platform_user_id, role)
     VALUES ($1,$2,$3,'member') ON CONFLICT (group_id, platform_user_id) DO NOTHING`,
    [groupId, acc[0]?.id ?? null, platformUserId],
  );
  await emitWs(client, "member_changed", { groupId, platformUserId, change: "joined" });
  await ctx.hooks.onMemberJoined(client, groupId, platformUserId);
}

async function onMemberLeft(
  ctx: AppContext,
  client: pg.PoolClient,
  ev: SseEvent,
): Promise<void> {
  const d = ev.data;
  const groupId = await groupByGatewayId(client, String(d.groupId));
  if (!groupId) {
    await client.query(
      "INSERT INTO dead_events (event_id, type, payload, error) VALUES ($1,$2,$3,$4)",
      [ev.id, ev.type, JSON.stringify(ev.data), "member_left for unknown group"],
    );
    await emitWs(client, "inconsistency", {
      kind: "unknown_group",
      ref: d.groupId,
      message: "member_left event for unknown group",
    });
    return;
  }
  const platformUserId = String(d.platformUserId);
  // rowCount=0 means the terminal cascade already removed the member and
  // emitted member_changed — do not emit a duplicate.
  const { rowCount } = await client.query(
    "DELETE FROM group_members WHERE group_id=$1 AND platform_user_id=$2",
    [groupId, platformUserId],
  );
  if (rowCount) {
    await emitWs(client, "member_changed", { groupId, platformUserId, change: "left" });
  }
}

async function onAccountStatus(
  ctx: AppContext,
  client: pg.PoolClient,
  d: Record<string, unknown>,
): Promise<void> {
  const accountId = String(d.accountId);
  const status = String(d.status);
  if (status !== "suspended" && status !== "session_expired") return;
  const { rows } = await client.query("SELECT 1 FROM accounts WHERE id=$1", [accountId]);
  if (!rows[0]) return;
  await enterTerminalTx(client, accountId, status);
}
