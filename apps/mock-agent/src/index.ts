import Fastify, { FastifyInstance, FastifyReply } from "fastify";

// Script step consumed in order per runId on each /agent/turn call.
export type Step =
  | { kind: "tool_use"; name: string; input: Record<string, unknown>; id?: string }
  | { kind: "end_turn"; text: string }
  | { kind: "raw"; status?: number; body: string; contentType?: string }
  | { kind: "delay"; ms: number; hang?: boolean; then: Step }
  | { kind: "echo_prev_id" };

export interface AuditRule {
  match?: string;
  verdict?: "pass" | "fail" | "raw";
  raw?: { status?: number; body: string };
  delayMs?: number;
  hang?: boolean;
  times?: number;
}

interface ScriptBody {
  runs?: Record<string, Step[]>;
  audit?: AuditRule[];
}

interface AgentState {
  scripts: Map<string, Step[]>;
  auditRules: AuditRule[];
  lastToolUseIds: Map<string, string>;
  tuSeq: number;
  turnCalls: Array<{ runId: string; body: unknown }>;
  auditCalls: Array<{ body: unknown }>;
}

const EXPECTED_TOOLS = ["get_recent_messages", "send_message", "kick_user", "finish"];

function toolsValid(tools: unknown): boolean {
  if (!Array.isArray(tools) || tools.length !== EXPECTED_TOOLS.length) return false;
  const names = tools.map((t) => (t as { name?: string }).name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_TOOLS].sort())) return false;
  for (const t of tools) {
    const schema = (t as { input_schema?: { properties?: object; required?: string[] } })
      .input_schema;
    if (!schema || typeof schema !== "object" || !schema.properties) return false;
    const props = Object.keys(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (!props.every((p) => required.includes(p))) return false;
  }
  return true;
}

function err(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ error: { code, message: code } });
}

export function buildMockAgent(): FastifyInstance {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const st: AgentState = {
    scripts: new Map(),
    auditRules: [],
    lastToolUseIds: new Map(),
    tuSeq: 0,
    turnCalls: [],
    auditCalls: [],
  };

  const scriptFor = (runId: string): Step[] | undefined => {
    for (const [key, steps] of st.scripts) {
      if (key === "*" || runId.startsWith(key)) return steps;
    }
    return undefined;
  };

  const respond = async (reply: FastifyReply, runId: string, step: Step): Promise<unknown> => {
    switch (step.kind) {
      case "tool_use": {
        const id = step.id ?? `tu_${++st.tuSeq}`;
        st.lastToolUseIds.set(runId, id);
        return reply.send({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id, name: step.name, input: step.input }],
        });
      }
      case "end_turn":
        return reply.send({
          stop_reason: "end_turn",
          content: [{ type: "text", text: step.text }],
        });
      case "raw":
        return reply
          .code(step.status ?? 200)
          .header("content-type", step.contentType ?? "application/json")
          .send(step.body);
      case "delay": {
        if (step.hang) return new Promise(() => {}); // never responds
        await new Promise((r) => setTimeout(r, step.ms));
        return respond(reply, runId, step.then);
      }
      case "echo_prev_id": {
        const id = st.lastToolUseIds.get(runId) ?? `tu_${++st.tuSeq}`;
        st.lastToolUseIds.set(runId, id);
        return reply.send({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id, name: "get_recent_messages", input: { limit: 5 } }],
        });
      }
    }
  };

  app.post("/agent/turn", async (req, reply) => {
    const body = (req.body ?? {}) as { runId?: string; tools?: unknown; messages?: unknown };
    if (!body.runId || !toolsValid(body.tools)) {
      return err(reply, 400, "TOOLS_INVALID");
    }
    st.turnCalls.push({ runId: body.runId, body });
    const steps = scriptFor(body.runId);
    const step =
      steps && steps.length > 0 ? steps.shift()! : { kind: "end_turn" as const, text: "done" };
    return respond(reply, body.runId, step);
  });

  app.post("/agent/audit", async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string };
    st.auditCalls.push({ body });
    const text = body.text ?? "";
    for (const rule of st.auditRules) {
      const used = (rule as { _used?: number })._used ?? 0;
      if (rule.times !== undefined && used >= rule.times) continue;
      if (rule.match !== undefined && !text.includes(rule.match)) continue;
      (rule as { _used?: number })._used = used + 1;
      if (rule.hang) return new Promise(() => {});
      if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
      if (rule.verdict === "raw") {
        return reply
          .code(rule.raw?.status ?? 200)
          .header("content-type", "application/json")
          .send(rule.raw?.body ?? "");
      }
      return reply.send({ verdict: rule.verdict ?? "pass" });
    }
    return reply.send({ verdict: "pass" });
  });

  app.post("/__admin/script", (req) => {
    const body = (req.body ?? {}) as ScriptBody;
    st.scripts.clear();
    for (const [key, steps] of Object.entries(body.runs ?? {})) {
      st.scripts.set(key, [...steps]);
    }
    st.auditRules = body.audit ?? [];
    return { ok: true };
  });

  app.post("/__admin/reset", () => {
    st.scripts.clear();
    st.auditRules = [];
    st.lastToolUseIds.clear();
    st.tuSeq = 0;
    st.turnCalls.length = 0;
    st.auditCalls.length = 0;
    return { ok: true };
  });

  app.get("/__admin/state", () => {
    const callsByRun: Record<string, unknown[]> = {};
    for (const c of st.turnCalls) {
      (callsByRun[c.runId] ??= []).push(c.body);
    }
    return {
      turnCalls: st.turnCalls,
      turnCallsByRun: callsByRun,
      auditCalls: st.auditCalls,
    };
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildMockAgent();
  app.listen({ port: Number(process.env.PORT ?? 4100), host: "0.0.0.0" });
}
