import type { AppContext } from "../context.js";
import { runSequenceStepOnce } from "../domain/sequences/engine.js";
import { runLoop, type WorkerHandle } from "./loop.js";

export function startSequenceWorker(ctx: AppContext, intervalMs = 250): WorkerHandle {
  return runLoop("sequences", intervalMs, async () => {
    while (await runSequenceStepOnce(ctx)) {
      // drain queued claims
    }
  });
}
