import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { getPool } from "./pool";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../sql/migrations",
);

export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [814201002]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [file]);
      if (existing.rowCount) continue;

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [814201002]).catch(() => undefined);
    client.release();
  }
  return applied;
}

export async function withRollback<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = getPool();
  if (!pool) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  try {
    const applied = await migrate(pool);
    if (applied.length === 0) {
      console.log("Migrations already applied.");
    } else {
      for (const file of applied) console.log(`Applied ${file}`);
    }
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("server/src/db/migrate.ts")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Migration failed.";
    console.error(message);
    process.exit(1);
  });
}
