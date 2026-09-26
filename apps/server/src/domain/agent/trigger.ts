import crypto from "node:crypto";
import pg from "pg";
import type { InboundMessageRow } from "../../context.js";
import { emitWs } from "../../ws/emit.js";

export interface TriggerMessage {
  msgId: string | null;
  senderPlatformUserId: string | null;
  text: string | null;
  sentAt: number;
}

export function rowToTriggerMessage(row: {
  msg_id: string | null;
  sender_platform_user_id: string | null;
  text: string | null;
  sent_at: Date;
}): TriggerMessage {
  return {
    msgId: row.msg_id,
    senderPlatformUserId: row.sender_platform_user_id,
    text: row.text,
    sentAt: row.sent_at.getTime(),
  };
}

/**
 * A5.1 — runs inside the consumer's event tx. A non-own message in an
 * agent-enabled active group either starts a new run (unique partial index
 * enforces one running run per group) or is queued as pending for the next run.
 */
export async function onInboundMessageTrigger(
  client: pg.PoolClient,
  row: InboundMessageRow,
): Promise<void> {
  const { rows: groups } = await client.query<{ id: string }>(
    "SELECT id FROM groups WHERE id=$1 AND agent_enabled AND status='active'",
    [row.group_id],
  );
  if (!groups[0]) return;

  const runId = crypto.randomUUID();
  await client.query("SAVEPOINT agent_trigger");
  try {
    await client.query(
      "INSERT INTO agent_runs (id, group_id, status, trigger_messages) VALUES ($1,$2,'running',$3)",
      [runId, row.group_id, JSON.stringify([rowToTriggerMessage(row)])],
    );
    await client.query("RELEASE SAVEPOINT agent_trigger");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT agent_trigger");
    if ((err as { code?: string }).code !== "23505") throw err;
    await client.query(
      "INSERT INTO agent_pending_messages (run_group_id, message_pk) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [row.group_id, row.id],
    );
    return;
  }
  await emitWs(client, "agent_run", {
    runId,
    groupId: row.group_id,
    status: "running",
    endReason: null,
  });
}
