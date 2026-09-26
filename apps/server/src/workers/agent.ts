import type { AppContext } from "../context.js";
import { runAgentStepOnce } from "../domain/agent/engine.js";
import { runLoop, type WorkerHandle } from "./loop.js";

export function startAgentWorker(ctx: AppContext, intervalMs = 200): WorkerHandle {
  return runLoop("agent", intervalMs, async () => {
    while (await runAgentStepOnce(ctx)) {
      // drain queued claims
    }
  });
}
