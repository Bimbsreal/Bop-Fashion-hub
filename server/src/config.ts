import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type AppConfig = {
  port: number;
  databaseUrl: string | null;
  mediaDir: string;
  maxMediaBytes: number;
  maxMediaEdge: number;
  aiTestProvider: boolean;
  aiWorker: boolean;
  aiMaxAttempts: number;
  aiTimeoutMs: number;
  aiBackoffMs: number;
  aiStaleRunningMs: number;
  aiMaxTasksPerMinute: number;
  nodeEnv: string;
  paymentSimulation: boolean;
};

loadLocalEnv();

function loadLocalEnv() {
  const file = path.resolve(".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? "5000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const databaseUrl = env.DATABASE_URL?.trim() || null;
  const mediaDir = env.MEDIA_STORAGE_DIR?.trim() || path.resolve(".local/media");
  const maxMediaBytes = positiveInteger(env.MEDIA_MAX_BYTES, 8_388_608, "MEDIA_MAX_BYTES");
  const maxMediaEdge = positiveInteger(env.MEDIA_MAX_EDGE, 8_000, "MEDIA_MAX_EDGE");
  return {
    port,
    databaseUrl,
    mediaDir,
    maxMediaBytes,
    maxMediaEdge,
    aiTestProvider: flag(env.AI_TEST_PROVIDER),
    aiWorker: flag(env.AI_WORKER),
    aiMaxAttempts: positiveInteger(env.AI_TASK_MAX_ATTEMPTS, 3, "AI_TASK_MAX_ATTEMPTS"),
    aiTimeoutMs: positiveInteger(env.AI_TASK_TIMEOUT_MS, 10_000, "AI_TASK_TIMEOUT_MS"),
    aiBackoffMs: nonNegativeInteger(env.AI_TASK_BACKOFF_MS, 200, "AI_TASK_BACKOFF_MS"),
    aiStaleRunningMs: positiveInteger(env.AI_STALE_RUNNING_MS, 120_000, "AI_STALE_RUNNING_MS"),
    aiMaxTasksPerMinute: positiveInteger(env.AI_MAX_TASKS_PER_MINUTE, 30, "AI_MAX_TASKS_PER_MINUTE"),
    nodeEnv: env.NODE_ENV?.trim() || "development",
    paymentSimulation: flag(env.PAYMENT_SIMULATION),
  };
}

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
