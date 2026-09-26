import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
}

export async function listMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = await readdir(dir);
  return files
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ version: parseInt(f.split("_")[0]!, 10), name: f, filename: f }))
    .sort((a, b) => a.version - b.version);
}

export async function latestMigrationVersion(dir?: string): Promise<number> {
  const files = await listMigrationFiles(dir);
  return files.length ? files[files.length - 1]!.version : 0;
}

async function appliedVersions(client: pg.PoolClient): Promise<number[]> {
  const { rows } = await client.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return rows.map((r) => r.version);
}

export async function runMigrations(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<number[]> {
  const files = await listMigrationFiles(dir);
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version int PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    const done = new Set(await appliedVersions(client));
    for (const file of files) {
      if (done.has(file.version)) continue;
      const sql = await readFile(path.join(dir, file.filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          file.version,
          file.name,
        ]);
        await client.query("COMMIT");
        applied.push(file.version);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return applied;
  } finally {
    client.release();
  }
}

export async function currentSchemaVersion(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ max: number | null }>(
      "SELECT max(version) AS max FROM schema_migrations",
    );
    return rows[0]?.max ?? 0;
  } catch {
    return 0;
  } finally {
    client.release();
  }
}

/** Returns null when the schema is current, otherwise {current, expected}. */
export async function checkSchemaVersion(
  pool: pg.Pool,
  dir?: string,
): Promise<{ current: number; expected: number } | null> {
  const expected = await latestMigrationVersion(dir);
  const current = await currentSchemaVersion(pool);
  if (current < expected) return { current, expected };
  return null;
}
