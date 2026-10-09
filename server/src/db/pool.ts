import { Pool, type PoolClient } from "pg";
import { readConfig } from "../config";

let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (pool) return pool;
  const { databaseUrl } = readConfig();
  if (!databaseUrl) return null;
  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
  existing?: PoolClient,
): Promise<T> {
  if (existing) return work(existing);

  const active = getPool();
  if (!active) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = await active.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
