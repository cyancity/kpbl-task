import pg from "pg";
import { emitWs } from "../../ws/emit.js";

/** P4 will register an agent-run cancellation hook here. */
export const onGroupUnreachable: Array<(client: pg.PoolClient, groupId: string) => Promise<void>> =
  [];

export async function markGroupUnreachable(client: pg.PoolClient, groupId: string): Promise<void> {
  const { rowCount } = await client.query(
    "UPDATE groups SET status = 'unreachable' WHERE id = $1 AND status <> 'unreachable'",
    [groupId],
  );
  if (!rowCount) return;
  const { rows: stopped } = await client.query<{ id: string }>(
    "UPDATE sequence_runs SET status = 'stopped', updated_at = now() WHERE group_id = $1 AND status = 'running' RETURNING id",
    [groupId],
  );
  for (const run of stopped) {
    await emitWs(client, "sequence_run", {
      runId: run.id,
      groupId,
      status: "stopped",
      currentStepIndex: null,
    });
  }
  for (const hook of onGroupUnreachable) {
    await hook(client, groupId);
  }
  await emitWs(client, "group_status_changed", { groupId, status: "unreachable" });
}
