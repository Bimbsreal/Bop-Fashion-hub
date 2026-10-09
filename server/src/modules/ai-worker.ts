import type { Pool, PoolClient } from "pg";
import { addEvent } from "./ai-tasks";
import { extractionCapability, parseGarmentAnalysis, saveAnalysisResult, type AnalysisAttribute } from "./garment-analysis";
import {
  isRetryable,
  normalizeFailure,
  ProviderFailure,
  selectProvider,
  type AiProvider,
  type ErrorCategory,
} from "./ai-provider";

export type WorkerSettings = {
  providers: AiProvider[];
  timeoutMs: number;
  backoffMs: number;
  staleRunningMs: number;
  workerId?: string;
};

type ClaimedTask = {
  id: string;
  capability: string;
  provider_id: string | null;
  attempt_count: number;
  max_attempts: number;
  input: { outcome: string | null; mediaIds: string[]; designProjectId: string | null };
};

export async function runWorkerOnce(pool: Pool, settings: WorkerSettings): Promise<{ taskId: string | null }> {
  await recoverStale(pool, settings);
  const claimed = await claim(pool, settings.workerId ?? "local");
  if (!claimed) return { taskId: null };
  const provider = claimed.provider_id
    ? settings.providers.find((item) => item.id === claimed.provider_id) ?? null
    : selectProvider(settings.providers, claimed.capability);
  const started = Date.now();
  if (!provider || !provider.capabilities().some((item) => item.id === claimed.capability)) {
    await finishFailure(pool, settings, claimed, started, {
      category: "unsupported_capability",
      message: "No provider is configured for this capability.",
    });
    return { taskId: claimed.id };
  }
  try {
    const result = await withTimeout(
      provider.execute({
        taskId: claimed.id,
        capability: claimed.capability,
        attempt: claimed.attempt_count,
        idempotencyKey: claimed.id,
        input: {
          outcome: claimed.input.outcome,
          mediaIds: claimed.input.mediaIds,
          designProjectId: claimed.input.designProjectId,
        },
      }),
      settings.timeoutMs,
    );
    const attributes = extractionAttributes(claimed, result);
    if ("failure" in attributes) {
      await finishFailure(pool, settings, claimed, started, attributes.failure);
      return { taskId: claimed.id };
    }
    await finishSuccess(
      pool,
      claimed,
      started,
      provider.id,
      result.modelId,
      result.simulated,
      result.summary,
      attributes.value,
    );
  } catch (error) {
    await finishFailure(pool, settings, claimed, started, normalizeFailure(error));
  }
  return { taskId: claimed.id };
}

async function recoverStale(pool: Pool, settings: WorkerSettings): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recovered = await client.query<{ id: string; attempt_count: number; max_attempts: number }>(
      `UPDATE ai_tasks
       SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
           completed_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END,
           error_category = CASE WHEN attempt_count >= max_attempts THEN 'timeout' ELSE error_category END,
           error_message = CASE
             WHEN attempt_count >= max_attempts THEN 'The attempt stopped before it finished.'
             ELSE error_message
           END,
           locked_by = NULL,
           locked_at = NULL,
           run_after = now()
       WHERE status = 'running'
         AND locked_at < now() - ($1::int * interval '1 millisecond')
       RETURNING id, attempt_count, max_attempts`,
      [settings.staleRunningMs],
    );
    for (const row of recovered.rows) {
      if (row.attempt_count >= row.max_attempts) {
        await addEvent(client, row.id, "permanently_failed", "The attempt stopped before it finished.");
      } else {
        await addEvent(client, row.id, "retry_scheduled", "Stale attempt returned to the queue.");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claim(pool: Pool, workerId: string): Promise<ClaimedTask | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<ClaimedTask>(
      `UPDATE ai_tasks
       SET status = 'running',
           locked_by = $1,
           locked_at = now(),
           started_at = COALESCE(started_at, now()),
           attempt_count = attempt_count + 1
       WHERE id = (
         SELECT id FROM ai_tasks
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, capability, provider_id, attempt_count, max_attempts, input`,
      [workerId],
    );
    const row = claimed.rows[0];
    if (row) await addEvent(client, row.id, "started", "Attempt started.");
    await client.query("COMMIT");
    return row ? { ...row, input: readInput(row.input) } : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function extractionAttributes(
  task: ClaimedTask,
  result: { simulated: boolean; document?: unknown },
): { value: AnalysisAttribute[] | null } | { failure: { category: ErrorCategory; message: string } } {
  if (task.capability !== extractionCapability) return { value: null };
  if (!result.simulated) {
    return { failure: { category: "permanent", message: "A real analysis provider is not configured." } };
  }
  if (task.input.mediaIds.length !== 1) {
    return { failure: { category: "invalid_request", message: "Provide one image." } };
  }
  const parsed = parseGarmentAnalysis(result.document);
  if (!parsed.ok) return { failure: { category: "invalid_response", message: parsed.message } };
  return { value: parsed.attributes };
}

async function finishSuccess(
  pool: Pool,
  task: ClaimedTask,
  started: number,
  providerId: string,
  modelId: string | null,
  simulated: boolean,
  summary: string,
  attributes: AnalysisAttribute[] | null,
): Promise<void> {
  const duration = Math.max(0, Date.now() - started);
  await withClient(pool, async (client) => {
    const updated = await client.query(
      `UPDATE ai_tasks
       SET status = 'succeeded', completed_at = now(), error_category = NULL, error_message = NULL,
           model_id = $3, locked_by = NULL, locked_at = NULL
       WHERE id = $1 AND status = 'running' AND attempt_count = $2`,
      [task.id, task.attempt_count, modelId],
    );
    if (!updated.rowCount) return;
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO ai_task_attempts (
         task_id, attempt_number, provider_id, model_id, status, finished_at, duration_ms
       )
       VALUES ($1, $2, $3, $4, 'succeeded', now(), $5)
       RETURNING id`,
      [task.id, task.attempt_count, providerId, modelId, duration],
    );
    const attemptId = attempt.rows[0]?.id;
    if (!attemptId) throw new Error("Attempt was not recorded.");
    await client.query(
      `INSERT INTO ai_task_outputs (task_id, attempt_id, provider_id, model_id, simulated, summary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [task.id, attemptId, providerId, modelId, simulated, summary],
    );
    await client.query(
      `INSERT INTO ai_usage_records (
         task_id, attempt_id, provider_id, model_id, source, duration_ms
       )
       VALUES ($1, $2, $3, $4, 'unreported', $5)`,
      [task.id, attemptId, providerId, modelId, duration],
    );
    await addEvent(client, task.id, "completed", "Task completed.");
    if (attributes && task.capability === extractionCapability) {
      const mediaId = task.input.mediaIds[0];
      if (!mediaId) throw new Error("Analysis image was not recorded.");
      await saveAnalysisResult(client, {
        taskId: task.id,
        mediaId,
        providerId,
        modelId,
        simulated,
        attributes,
      });
    }
  });
}

async function finishFailure(
  pool: Pool,
  settings: WorkerSettings,
  task: ClaimedTask,
  started: number,
  failure: { category: ErrorCategory; message: string },
): Promise<void> {
  const duration = Math.max(0, Date.now() - started);
  const retry = isRetryable(failure.category) && task.attempt_count < task.max_attempts;
  const delay = retry ? backoffDelay(settings.backoffMs, task.attempt_count) : 0;
  await withClient(pool, async (client) => {
    const updated = await client.query(
      `UPDATE ai_tasks
       SET status = $3,
           error_category = $4,
           error_message = $5,
           completed_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END,
           run_after = CASE WHEN $3 = 'queued' THEN now() + ($6::int * interval '1 millisecond') ELSE run_after END,
           locked_by = NULL,
           locked_at = NULL
       WHERE id = $1 AND status = 'running' AND attempt_count = $2`,
      [task.id, task.attempt_count, retry ? "queued" : "failed", failure.category, failure.message, delay],
    );
    if (!updated.rowCount) return;
    const attempt = await client.query<{ id: string }>(
      `INSERT INTO ai_task_attempts (
         task_id, attempt_number, provider_id, status, error_category, error_message, finished_at, duration_ms
       )
       VALUES ($1, $2, $3, 'failed', $4, $5, now(), $6)
       RETURNING id`,
      [task.id, task.attempt_count, task.provider_id ?? "unconfigured", failure.category, failure.message, duration],
    );
    const attemptId = attempt.rows[0]?.id;
    if (!attemptId) throw new Error("Attempt was not recorded.");
    await client.query(
      `INSERT INTO ai_usage_records (task_id, attempt_id, provider_id, source, duration_ms)
       VALUES ($1, $2, $3, 'unreported', $4)`,
      [task.id, attemptId, task.provider_id ?? "unconfigured", duration],
    );
    await addEvent(client, task.id, "attempt_failed", "Attempt failed.");
    if (retry) await addEvent(client, task.id, "retry_scheduled", "Retry scheduled.");
    else await addEvent(client, task.id, "permanently_failed", "Task failed.");
  });
}

function readInput(value: ClaimedTask["input"]): ClaimedTask["input"] {
  const record = typeof value === "string" ? (JSON.parse(value) as ClaimedTask["input"]) : value;
  return {
    outcome: typeof record.outcome === "string" ? record.outcome : null,
    mediaIds: Array.isArray(record.mediaIds) ? record.mediaIds.filter((item) => typeof item === "string") : [],
    designProjectId: typeof record.designProjectId === "string" ? record.designProjectId : null,
  };
}

function backoffDelay(base: number, attempt: number): number {
  if (base <= 0) return 0;
  const shift = Math.min(Math.max(attempt, 1), 5);
  return Math.min(base * 2 ** (shift - 1), 60_000);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProviderFailure("timeout", "The attempt timed out."));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function withClient(pool: Pool, work: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
