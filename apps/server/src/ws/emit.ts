import pg from "pg";

export async function emitWs(
  client: pg.PoolClient,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query("INSERT INTO ws_events (type, payload) VALUES ($1, $2)", [
    type,
    JSON.stringify(payload),
  ]);
}
