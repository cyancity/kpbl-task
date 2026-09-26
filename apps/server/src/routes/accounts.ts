import { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACCOUNT_STATUSES, type AccountStatus } from "@gmp/shared";
import { connectAccount, transitionAccount } from "../domain/accounts/service.js";
import type { AppContext } from "../context.js";

const transitionSchema = z.object({
  to: z.enum(ACCOUNT_STATUSES),
  expectedFrom: z.enum(ACCOUNT_STATUSES),
});

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/accounts", async () => {
    const { rows } = await ctx.pool.query<{
      id: string;
      status: AccountStatus;
      platform_user_id: string | null;
      rate_limited_until: Date | null;
    }>("SELECT id, status, platform_user_id, rate_limited_until FROM accounts ORDER BY id");
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      platformUserId: r.platform_user_id,
      rateLimitedUntil: r.rate_limited_until ? r.rate_limited_until.toISOString() : null,
    }));
  });

  app.post("/api/accounts/:id/connect", async (req) => {
    const { id } = req.params as { id: string };
    return connectAccount(ctx.pool, ctx.gateway, id);
  });

  app.post("/api/accounts/:id/transition", async (req) => {
    const { id } = req.params as { id: string };
    const body = transitionSchema.parse(req.body);
    const updated = await transitionAccount(ctx.pool, ctx.gateway, {
      accountId: id,
      to: body.to,
      expectedFrom: body.expectedFrom,
      source: "operator",
    });
    return { status: updated.status };
  });
}
