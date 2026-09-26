import { createPool } from "./pool.js";
import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  const applied = await runMigrations(pool);
  console.log(
    applied.length ? `Applied migrations: ${applied.join(", ")}` : "No pending migrations",
  );
} finally {
  await pool.end();
}
