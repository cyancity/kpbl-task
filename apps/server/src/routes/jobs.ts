import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { initialCreateGroupState, initialLeaveAllState } from "../domain/jobs/engine.js";
import type { AppContext } from "../context.js";

const createSchema = z.object({
  creatorAccountId: z.string().min(1),
  memberAccountIds: z.array(z.string().min(1)).min(1),
});

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/groups", async (req, reply) => {
    const body = createSchema.parse(req.body);
    const ids = new Set(body.memberAccountIds);
    if (ids.size !== body.memberAccountIds.length || ids.has(body.creatorAccountId)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "memberAccountIds must be unique and not contain the creator",
      );
    }
    const allIds = [body.creatorAccountId, ...body.memberAccountIds];
    const { rows: accounts } = await ctx.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM accounts WHERE id = ANY($1::text[])",
      [allIds],
    );
    const byId = new Map(accounts.map((a) => [a.id, a.status]));
    for (const id of allIds) {
      if (!byId.has(id)) {
        throw new AppError(404, "ACCOUNT_NOT_FOUND", `account ${id} not found`);
      }
    }
    for (const id of allIds) {
      if (byId.get(id) !== "online") {
        throw new AppError(422, "ACCOUNT_NOT_ONLINE", `account ${id} is not online`, {
          accountId: id,
        });
      }
    }

    const groupId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const state = {
      ...initialCreateGroupState(body.memberAccountIds),
      creatorAccountId: body.creatorAccountId,
    };
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO groups (id, status, creator_account_id) VALUES ($1,'creating',$2)",
        [groupId, body.creatorAccountId],
      );
      await client.query(
        "INSERT INTO jobs (id, kind, group_id, status, state) VALUES ($1,'create_group',$2,'running',$3)",
        [jobId, groupId, JSON.stringify(state)],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return reply.code(202).send({ jobId, groupId });
  });

  app.post("/api/groups/:id/leave-all", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await ctx.pool.query<{
      status: string;
      gateway_group_id: string | null;
      creator_account_id: string;
    }>("SELECT status, gateway_group_id, creator_account_id FROM groups WHERE id=$1", [id]);
    const group = rows[0];
    if (!group) throw new AppError(404, "GROUP_NOT_FOUND", `group ${id} not found`);
    if (group.status !== "active") {
      throw new AppError(409, "GROUP_NOT_ACTIVE", `group ${id} is ${group.status}`);
    }
    const jobId = crypto.randomUUID();
    await ctx.pool.query(
      "INSERT INTO jobs (id, kind, group_id, status, state) VALUES ($1,'leave_all',$2,'running',$3)",
      [
        jobId,
        id,
        JSON.stringify(
          initialLeaveAllState(group.gateway_group_id!, group.creator_account_id),
        ),
      ],
    );
    return reply.code(202).send({ jobId });
  });

  app.get("/api/jobs/:jobId", async (req) => {
    const { jobId } = req.params as { jobId: string };
    const { rows } = await ctx.pool.query<{
      id: string;
      kind: string;
      group_id: string;
      status: string;
      errors: unknown;
    }>("SELECT id, kind, group_id, status, errors FROM jobs WHERE id=$1", [jobId]);
    if (!rows[0]) throw new AppError(404, "NOT_FOUND", `job ${jobId} not found`);
    return {
      id: rows[0].id,
      kind: rows[0].kind,
      groupId: rows[0].group_id,
      status: rows[0].status,
      errors: rows[0].errors,
    };
  });
}
