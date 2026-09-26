import type { AppContext } from "../context.js";
import { startConsumer, type ConsumerHandle } from "../gateway/consumer.js";
import { startSenderWorker } from "./sender.js";
import { startReconcilerWorker } from "./unknownReconciler.js";
import { startRateLimitWorker } from "./rateLimit.js";
import { startWsPusher } from "../ws/server.js";
import { startJobWorker } from "./jobs.js";
import { startAgentWorker } from "./agent.js";
import { startSequenceWorker } from "./sequences.js";
import type { WorkerHandle } from "./loop.js";

export interface WorkersHandle {
  stop: () => Promise<void>;
}

export function startWorkers(ctx: AppContext): WorkersHandle {
  const handles: Array<WorkerHandle | ConsumerHandle> = [
    startSenderWorker(ctx),
    startReconcilerWorker(ctx),
    startRateLimitWorker(ctx),
    startJobWorker(ctx),
    startAgentWorker(ctx),
    startSequenceWorker(ctx),
    startWsPusher(ctx),
    startConsumer(ctx),
  ];
  return {
    stop: async () => {
      await Promise.all(handles.map((h) => h.stop()));
    },
  };
}
