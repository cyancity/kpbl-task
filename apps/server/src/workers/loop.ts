export interface WorkerHandle {
  name: string;
  stop: () => Promise<void>;
}

type Logger = { warn: (obj: object, msg: string) => void };

/**
 * Runs `fn` every `intervalMs` until stopped. `fn` errors are logged, never
 * thrown, so a single bad tick cannot kill the worker.
 */
export function runLoop(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
  log?: Logger,
): WorkerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const tick = async () => {
    if (stopped) return;
    running = (async () => {
      try {
        await fn();
      } catch (err) {
        log?.warn({ err, worker: name }, "worker tick failed");
      }
    })();
    await running;
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    }
  };
  void tick();

  return {
    name,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running.catch(() => {});
    },
  };
}
