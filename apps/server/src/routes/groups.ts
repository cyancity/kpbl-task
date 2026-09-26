import { FastifyInstance } from "fastify";
import { z } from "zod";
import pg from "pg";
import { AppError, requireUuid } from "../errors.js";
import { sendToGroup } from "../domain/messages/outbox.js";
import type { AppContext } from "../context.js";

const patchSchema = z
  .object({
    agentEnabled: z.boolean().optional(),
    autoKickEnabled: z.boolean().optional(),
  })
  .strict();

const sendSchema = z.object({
  accountId: z.string().min(1),
  text: z.string(),
});

async function groupView(client: pg.Pool | pg.PoolClient, id: string) {
  const { rows: groups } = await client.query<{
    id: string;
    gateway_group_id: string | null;
    status: string;
    creator_account_id: string;
    agent_enabled: boolean;
    auto_kick_enabled: boolean;
  }>(
    "SELECT id, gateway_group_id, status, creator_account_id, agent_enabled, auto_kick_enabled FROM groups WHERE id = $1",
    [id],
  );
  const g = groups[0];
  if (!g) return null;
  const { rows: members } = await client.query<{
    account_id: string | null;
    platform_user_id: string;
    role: string;
  }>(
    "SELECT account_id, platform_user_id, role FROM group_members WHERE group_id = $1 ORDER BY joined_at",
    [id],
  );
  const { rows: seqRun } = await client.query<{ id: string }>(
    "SELECT id FROM sequence_runs WHERE group_id = $1 AND status = 'running'",
    [id],
  );
  const { rows: agentRun } = await client.query<{ id: string }>(
    "SELECT id FROM agent_runs WHERE group_id = $1 AND status = 'running'",
    [id],
  );
  return {
    id: g.id,
    gatewayGroupId: g.gateway_group_id,
    status: g.status,
    creatorAccountId: g.creator_account_id,
    agentEnabled: g.agent_enabled,
    autoKickEnabled: g.auto_kick_enabled,
    members: members.map((m) => ({
      accountId: m.account_id,
      platformUserId: m.platform_user_id,
      role: m.role,
    })),
    activeSequenceRunId: seqRun[0]?.id ?? null,
    activeAgentRunId: agentRun[0]?.id ?? null,
  };
}

export function registerGroupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/groups", async () => {
    const { rows } = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM groups ORDER BY created_at",
    );
    const views = await Promise.all(rows.map((r) => groupView(ctx.pool, r.id)));
    return views.filter(Boolean);
  });

  app.get("/api/groups/:id", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const view = await groupView(ctx.pool, id);
    if (!view) throw new AppError(404, "GROUP_NOT_FOUND", `group ${id} not found`);
    return view;
  });

  app.patch("/api/groups/:id", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const body = patchSchema.parse(req.body);
    const { rowCount } = await ctx.pool.query(
      `UPDATE groups SET
         agent_enabled = COALESCE($2, agent_enabled),
         auto_kick_enabled = COALESCE($3, auto_kick_enabled)
       WHERE id = $1`,
      [id, body.agentEnabled ?? null, body.autoKickEnabled ?? null],
    );
    if (!rowCount) throw new AppError(404, "GROUP_NOT_FOUND", `group ${id} not found`);
    return groupView(ctx.pool, id);
  });

  app.post("/api/groups/:id/send", async (req, reply) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const body = sendSchema.parse(req.body);
    const result = await sendToGroup(ctx.pool, id, body.accountId, body.text);
    return reply.code(202).send(result);
  });

  app.get("/api/groups/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);

    let before: { s: string; i: number } | null = null;
    if (q.before) {
      try {
        before = JSON.parse(Buffer.from(q.before, "base64url").toString("utf8"));
      } catch {
        throw new AppError(400, "VALIDATION_ERROR", "invalid before cursor");
      }
    }

    const { rows } = await ctx.pool.query<{
      id: string;
      msg_id: string | null;
      client_msg_id: string | null;
      sender_platform_user_id: string | null;
      is_own: boolean;
      text: string | null;
      sent_at: Date;
      delivery_status: string | null;
      fail_code: string | null;
    }>(
      `SELECT id, msg_id, client_msg_id, sender_platform_user_id, is_own, text,
              sent_at, delivery_status, fail_code
         FROM messages
        WHERE group_id = $1
          ${before ? "AND (sent_at, id) < ($3::timestamptz, $4)" : ""}
        ORDER BY sent_at DESC, id DESC
        LIMIT $2`,
      before ? [id, limit + 1, before.s, before.i] : [id, limit + 1],
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
      msgId: r.msg_id,
      clientMsgId: r.client_msg_id,
      senderPlatformUserId: r.sender_platform_user_id,
      isOwn: r.is_own,
      text: r.text,
      sentAt: r.sent_at.toISOString(),
      // 'sending' is an internal transient state; the API enum exposes it as
      // 'queued' (the message is still in the outbound pipeline).
      deliveryStatus: r.delivery_status === "sending" ? "queued" : r.delivery_status,
      failCode: r.fail_code,
    }));
    const last = rows[Math.min(items.length, limit) - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ s: last.sent_at.toISOString(), i: Number(last.id) }),
          ).toString("base64url")
        : null;
    return { items, nextCursor };
  });
}
