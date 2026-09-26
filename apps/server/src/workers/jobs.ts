import type { AppContext } from "../context.js";
import { runJobOnce } from "../domain/jobs/engine.js";
import { runLoop, type WorkerHandle } from "./loop.js";

export function startJobWorker(ctx: AppContext, intervalMs = 200): WorkerHandle {
  return runLoop(
    "jobs",
    intervalMs,
    async () => {
      // Drain runnable jobs; each claim performs one persisted step.
      while (await runJobOnce(ctx)) {
        /* keep claiming */
      }
    },
    ctx.log,
  );
}
