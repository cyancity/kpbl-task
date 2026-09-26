import type { AppContext } from "../context.js";
import { transitionAccountTx } from "../domain/accounts/service.js";
import { AppError } from "../errors.js";
import { runLoop, type WorkerHandle } from "./loop.js";

export async function rateLimitTick(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    "SELECT id FROM accounts WHERE status='rate_limited' AND rate_limited_until <= now() LIMIT 10",
  );
  for (const { id } of rows) {
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await transitionAccountTx(client, {
        accountId: id,
        to: "online",
        expectedFrom: "rate_limited",
        source: "system",
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // CAS_CONFLICT means an operator already moved it: spec says do nothing.
      if (!(err instanceof AppError && err.code === "CAS_CONFLICT")) throw err;
    } finally {
      client.release();
    }
  }
}

export function startRateLimitWorker(ctx: AppContext, intervalMs = 250): WorkerHandle {
  return runLoop("rate-limit-expiry", intervalMs, () => rateLimitTick(ctx), ctx.log);
}
