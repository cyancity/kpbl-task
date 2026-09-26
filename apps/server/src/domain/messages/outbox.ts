import crypto from "node:crypto";
import pg from "pg";
import { AppError } from "../../errors.js";

export interface EnqueueSendOptions {
  groupId: string;
  accountId: string;
  text: string;
  sequenceRunStepId?: string;
  agentStepId?: string;
}

export async function enqueueSend(
  client: pg.PoolClient,
  opts: EnqueueSendOptions,
): Promise<{ clientMsgId: string }> {
  const { rows: acc } = await client.query<{ platform_user_id: string | null }>(
    "SELECT platform_user_id FROM accounts WHERE id = $1",
    [opts.accountId],
  );
  const clientMsgId = crypto.randomUUID();
  await client.query(
    `INSERT INTO messages
       (group_id, client_msg_id, sender_account_id, sender_platform_user_id,
        is_own, text, sent_at, delivery_status, sequence_run_step_id, agent_step_id)
     VALUES ($1,$2,$3,$4,true,$5,now(),'queued',$6,$7)`,
    [
      opts.groupId,
      clientMsgId,
      opts.accountId,
      acc[0]?.platform_user_id ?? null,
      opts.text,
      opts.sequenceRunStepId ?? null,
      opts.agentStepId ?? null,
    ],
  );
  return { clientMsgId };
}

export interface SendRouteResult {
  clientMsgId: string;
}

/** POST /api/groups/:id/send body handling (validation happens in the route). */
export async function sendToGroup(
  pool: pg.Pool,
  groupId: string,
  accountId: string,
  text: string,
): Promise<SendRouteResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: groups } = await client.query("SELECT id FROM groups WHERE id = $1", [groupId]);
    if (!groups[0]) {
      throw new AppError(404, "GROUP_NOT_FOUND", `group ${groupId} not found`);
    }
    const { rows: members } = await client.query(
      "SELECT 1 FROM group_members WHERE group_id = $1 AND account_id = $2",
      [groupId, accountId],
    );
    if (!members[0]) {
      throw new AppError(
        409,
        "ACCOUNT_NOT_IN_GROUP",
        `account ${accountId} is not a member of group ${groupId}`,
      );
    }
    const { rows: accounts } = await client.query<{ status: string }>(
      "SELECT status FROM accounts WHERE id = $1",
      [accountId],
    );
    const status = accounts[0]?.status;
    if (!status || !["online", "rate_limited"].includes(status)) {
      throw new AppError(
        409,
        "ACCOUNT_UNAVAILABLE",
        `account ${accountId} is ${status ?? "unknown"}`,
      );
    }
    const { clientMsgId } = await enqueueSend(client, { groupId, accountId, text });
    await client.query("COMMIT");
    return { clientMsgId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
