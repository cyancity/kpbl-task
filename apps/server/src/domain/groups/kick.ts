import type { AppContext } from "../../context.js";
import { AppError } from "../../errors.js";
import { GatewayError } from "../../gateway/client.js";

const KICK_POLL_MS = 500;
const KICK_CONFIRM_MS = 2500;

export async function kickMember(
  ctx: AppContext,
  opts: { groupId: string; byAccountId: string; targetPlatformUserId: string },
): Promise<{ kicked: true }> {
  const { rows } = await ctx.pool.query<{ gateway_group_id: string | null }>(
    "SELECT gateway_group_id FROM groups WHERE id=$1",
    [opts.groupId],
  );
  const gatewayGroupId = rows[0]?.gateway_group_id;
  if (!gatewayGroupId) {
    throw new AppError(404, "GROUP_NOT_FOUND", `group ${opts.groupId} not found`);
  }
  try {
    await ctx.gateway.kick(gatewayGroupId, opts.byAccountId, opts.targetPlatformUserId);
  } catch (err) {
    if (err instanceof GatewayError && err.code === "NETWORK_TIMEOUT") {
      return confirmKick(ctx, gatewayGroupId, opts.targetPlatformUserId);
    }
    if (err instanceof GatewayError) {
      throw new AppError(err.status, err.code, err.message);
    }
    throw err;
  }
  await removeMember(ctx, opts.groupId, opts.targetPlatformUserId);
  return { kicked: true };
}

async function removeMember(ctx: AppContext, groupId: string, platformUserId: string) {
  await ctx.pool.query(
    "DELETE FROM group_members WHERE group_id=$1 AND platform_user_id=$2",
    [groupId, platformUserId],
  );
}

async function confirmKick(
  ctx: AppContext,
  gatewayGroupId: string,
  targetPlatformUserId: string,
): Promise<{ kicked: true }> {
  const deadline = Date.now() + KICK_CONFIRM_MS;
  while (Date.now() < deadline) {
    const members = await ctx.gateway.members(gatewayGroupId);
    if (!members.some((m) => m.platformUserId === targetPlatformUserId)) {
      return { kicked: true };
    }
    await new Promise((r) => setTimeout(r, KICK_POLL_MS));
  }
  throw new AppError(504, "NETWORK_TIMEOUT", "kick result could not be confirmed");
}
