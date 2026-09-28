import { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, requireUuid } from "../errors.js";
import type { AppContext } from "../context.js";
import { resolveSequence, UnresolvedPlaceholder } from "../domain/sequences/resolve.js";
import { startSequenceRun } from "../domain/sequences/engine.js";

const stepSchema = z.object({
  index: z.number().int().min(1),
  accountRole: z.enum(["admin", "member"]),
  text: z.string(),
  delaySeconds: z.number().min(0),
});

const createSequenceSchema = z
  .object({
    name: z.string().min(1),
    steps: z.array(stepSchema).min(1),
  })
  .strict();

const varsSchema = z
  .object({
    vars: z.record(z.string()).optional(),
    stepVars: z.record(z.record(z.string())).optional(),
  })
  .strict();

const startRunSchema = z
  .object({
    sequenceId: z.string().uuid(),
    vars: z.record(z.string()).optional(),
    stepVars: z.record(z.record(z.string())).optional(),
  })
  .strict();

function normalizeSteps(steps: z.infer<typeof stepSchema>[]) {
  const sorted = [...steps].sort((a, b) => a.index - b.index);
  const indexes = new Set<number>();
  for (const s of sorted) {
    if (indexes.has(s.index)) {
      throw new AppError(400, "VALIDATION_ERROR", `duplicate step index ${s.index}`);
    }
    indexes.add(s.index);
  }
  sorted.forEach((s, i) => {
    if (s.index !== i + 1) {
      throw new AppError(400, "VALIDATION_ERROR", "step indexes must be contiguous 1..n");
    }
  });
  return sorted;
}

function unresolvedToAppError(err: unknown): never {
  if (err instanceof UnresolvedPlaceholder) {
    throw new AppError(422, "UNRESOLVED_PLACEHOLDER", err.message, {
      stepIndex: err.stepIndex,
      key: err.key,
    });
  }
  throw err;
}

function stepView(s: {
  index: number;
  status: string;
  scheduled_at: Date | null;
  sent_at: Date | null;
  client_msg_id: string | null;
  resolved_vars: unknown;
  var_sources: unknown;
  account_id: string | null;
  resolved_text: string | null;
}) {
  return {
    index: s.index,
    status: s.status,
    scheduledAt: s.scheduled_at?.toISOString() ?? null,
    sentAt: s.sent_at?.toISOString() ?? null,
    clientMsgId: s.client_msg_id,
    resolvedVars: s.resolved_vars,
    varSources: s.var_sources,
    accountId: s.account_id,
    text: s.resolved_text,
  };
}

export function registerSequenceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/api/sequences", async (req, reply) => {
    const body = createSequenceSchema.parse(req.body);
    const steps = normalizeSteps(body.steps);
    const id = crypto.randomUUID();
    await ctx.pool.query("INSERT INTO sequences (id, name, steps) VALUES ($1,$2,$3)", [
      id,
      body.name,
      JSON.stringify(steps),
    ]);
    return reply.code(201).send({ id });
  });

  app.get("/api/sequences", async () => {
    const { rows } = await ctx.pool.query(
      "SELECT id, name, steps, created_at FROM sequences ORDER BY created_at",
    );
    return rows.map((r: { id: string; name: string; steps: unknown; created_at: Date }) => ({
      id: r.id,
      name: r.name,
      steps: r.steps,
      createdAt: r.created_at.toISOString(),
    }));
  });

  app.get("/api/sequences/:id", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "SEQUENCE_NOT_FOUND");
    const { rows } = await ctx.pool.query<{
      id: string;
      name: string;
      steps: unknown;
      created_at: Date;
    }>("SELECT id, name, steps, created_at FROM sequences WHERE id=$1", [id]);
    if (!rows[0]) throw new AppError(404, "SEQUENCE_NOT_FOUND", `sequence ${id} not found`);
    return {
      id: rows[0].id,
      name: rows[0].name,
      steps: rows[0].steps,
      createdAt: rows[0].created_at.toISOString(),
    };
  });

  app.post("/api/sequences/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "SEQUENCE_NOT_FOUND");
    const body = varsSchema.parse(req.body);
    const { rows } = await ctx.pool.query<{ steps: { index: number; text: string }[] }>(
      "SELECT steps FROM sequences WHERE id=$1",
      [id],
    );
    if (!rows[0]) throw new AppError(404, "SEQUENCE_NOT_FOUND", `sequence ${id} not found`);
    try {
      return resolveSequence(rows[0].steps, body.vars, body.stepVars);
    } catch (err) {
      unresolvedToAppError(err);
    }
  });

  app.post("/api/groups/:id/sequence-runs", async (req, reply) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const body = startRunSchema.parse(req.body);
    const result = await startSequenceRun(ctx, {
      groupId: id,
      sequenceId: body.sequenceId,
      ...(body.vars ? { vars: body.vars } : {}),
      ...(body.stepVars ? { stepVars: body.stepVars } : {}),
    });
    return reply.code(201).send({ runId: result.runId });
  });

  app.get("/api/sequence-runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "SEQUENCE_RUN_NOT_FOUND");
    const { rows } = await ctx.pool.query<{
      id: string;
      group_id: string;
      sequence_id: string;
      status: string;
      current_step_index: number | null;
    }>(
      "SELECT id, group_id, sequence_id, status, current_step_index FROM sequence_runs WHERE id=$1",
      [id],
    );
    const run = rows[0];
    if (!run) throw new AppError(404, "SEQUENCE_RUN_NOT_FOUND", `sequence run ${id} not found`);
    const { rows: steps } = await ctx.pool.query(
      "SELECT * FROM sequence_run_steps WHERE run_id=$1 ORDER BY index",
      [id],
    );
    return {
      id: run.id,
      groupId: run.group_id,
      sequenceId: run.sequence_id,
      status: run.status,
      currentStepIndex: run.current_step_index,
      steps: steps.map(stepView),
    };
  });

  app.get("/api/groups/:id/sequence-runs", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const { rows } = await ctx.pool.query<{
      id: string;
      group_id: string;
      sequence_id: string;
      status: string;
      current_step_index: number | null;
    }>(
      "SELECT id, group_id, sequence_id, status, current_step_index FROM sequence_runs WHERE group_id=$1 ORDER BY created_at DESC",
      [id],
    );
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      sequenceId: r.sequence_id,
      status: r.status,
      currentStepIndex: r.current_step_index,
    }));
  });
}
