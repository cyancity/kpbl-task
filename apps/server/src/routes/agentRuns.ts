import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { AppError, requireUuid } from "../errors.js";
import { emitWs } from "../ws/emit.js";
import type { AppContext } from "../context.js";

function stepView(s: {
  seq: number;
  kind: string;
  tool_use_id: string | null;
  name: string | null;
  input: unknown;
  result_summary: string | null;
  is_error: boolean;
  error_code: string | null;
  audit_verdict: string | null;
  raw_response: string | null;
}) {
  return {
    seq: s.seq,
    kind: s.kind,
    toolUseId: s.tool_use_id,
    name: s.name,
    input: s.input,
    resultSummary: s.result_summary,
    isError: s.is_error,
    errorCode: s.error_code,
    auditVerdict: s.audit_verdict,
    rawResponse: s.raw_response,
  };
}

export function registerAgentRunRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/agent-runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "AGENT_RUN_NOT_FOUND");
    const { rows } = await ctx.pool.query<{
      id: string;
      group_id: string;
      status: string;
      end_reason: string | null;
      summary: string | null;
      created_at: Date;
      ended_at: Date | null;
    }>(
      "SELECT id, group_id, status, end_reason, summary, created_at, ended_at FROM agent_runs WHERE id=$1",
      [id],
    );
    const run = rows[0];
    if (!run) throw new AppError(404, "AGENT_RUN_NOT_FOUND", `agent run ${id} not found`);
    const { rows: steps } = await ctx.pool.query(
      "SELECT * FROM agent_steps WHERE run_id=$1 ORDER BY seq",
      [id],
    );
    return {
      id: run.id,
      groupId: run.group_id,
      status: run.status,
      endReason: run.end_reason,
      summary: run.summary,
      createdAt: run.created_at.toISOString(),
      endedAt: run.ended_at?.toISOString() ?? null,
      steps: steps.map(stepView),
    };
  });

  app.get("/api/groups/:id/agent-runs", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const { rows } = await ctx.pool.query<{
      id: string;
      group_id: string;
      status: string;
      end_reason: string | null;
      summary: string | null;
      created_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT id, group_id, status, end_reason, summary, created_at, ended_at
       FROM agent_runs WHERE group_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [id],
    );
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      status: r.status,
      endReason: r.end_reason,
      summary: r.summary,
      createdAt: r.created_at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
    }));
  });

  // 手动触发一次运行：与外部消息触发同一条路径（单群单 running run 由部分唯一索引保证）。
  // 要求 agentEnabled 开启且群 active，与自动触发的准入条件一致。
  app.post("/api/groups/:id/agent-runs", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "GROUP_NOT_FOUND");
    const runId = crypto.randomUUID();
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO agent_runs (id, group_id, status, trigger_messages)
         SELECT $1, id, 'running', '[]'::jsonb FROM groups
         WHERE id = $2 AND agent_enabled AND status = 'active'
         RETURNING id`,
        [runId, id],
      );
      if (!rows[0]) {
        const { rows: g } = await client.query<{ agent_enabled: boolean; status: string }>(
          "SELECT agent_enabled, status FROM groups WHERE id=$1",
          [id],
        );
        if (!g[0]) throw new AppError(404, "GROUP_NOT_FOUND", `group ${id} not found`);
        throw new AppError(409, "AGENT_DISABLED", "agentEnabled 未开启或群非 active");
      }
      await emitWs(client, "agent_run", {
        runId,
        groupId: id,
        status: "running",
        endReason: null,
      });
      await client.query("COMMIT");
      return { runId };
    } catch (e) {
      await client.query("ROLLBACK");
      if ((e as { code?: string }).code === "23505") {
        throw new AppError(409, "AGENT_RUN_ACTIVE", "已有运行中的 agent run");
      }
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/api/agent-runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    requireUuid(id, "AGENT_RUN_NOT_FOUND");
    const { rowCount } = await ctx.pool.query(
      "UPDATE agent_runs SET cancel_requested=true WHERE id=$1 AND status='running'",
      [id],
    );
    if (!rowCount) throw new AppError(404, "AGENT_RUN_NOT_FOUND", `agent run ${id} not found`);
    return { ok: true };
  });
}
