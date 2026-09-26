import pg from "pg";

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // pg emits 'error' on the pool when an idle client dies (e.g. the server
  // terminates the connection during a restart). Without a listener the event
  // is unhandled and crashes the whole process.
  pool.on("error", (err) => {
    console.error("pg idle client error:", err.message);
  });
  return pool;
}
