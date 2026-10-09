import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { assertCanActForOwner, ownerColumns, ownerFromIds, type OwnerRef } from "./access";
import { invalid, notFound } from "../errors";
import { requireProject } from "./design";
import { requireMedia } from "./uploads";
import { listCapabilities, parseTaskBody, type CapabilityView, type NormalizedInput } from "./ai-capabilities";
import { selectProvider, type AiProvider } from "./ai-provider";

const imageMimes = new Set(["image/jpeg", "image/png", "image/webp"]);

export type TaskView = {
  id: string;
  capability: string;
  status: string;
  simulated: boolean;
  attemptCount: number;
  maxAttempts: number;
  designProjectId: string | null;
  mediaIds: string[];
  error: { category: string; message: string } | null;
  result: {
    simulated: boolean;
    providerId: string;
    modelId: string | null;
    summary: string;
    media: { id: string } | null;
    usage: {
      source: string;
      inputUnits: number | null;
      outputUnits: number | null;
      imageCount: number | null;
      durationMs: number | null;
      estimatedCost: number | null;
      currency: string | null;
    };
  } | null;
  events: { kind: string; message: string; createdAt: string }[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TaskDraft = {
  actorUserId: string;
  owner: OwnerRef;
  capability: string;
  input: NormalizedInput;
  fingerprint: string;
  idempotencyKey: string | null;
  providerId: string;
  simulated: boolean;
  maxAttempts: number;
};

type TaskRow = {
  id: string;
  capability: string;
  status: string;
  simulated: boolean;
  attempt_count: number;
  max_attempts: number;
  design_project_id: string | null;
  error_category: string | null;
  error_message: string | null;
  provider_id: string | null;
  model_id: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  owner_user_id: string | null;
  owner_organization_id: string | null;
  input_fingerprint: string;
};

export async function prepareTask(
  client: PoolClient,
  actorUserId: string,
  body: Record<string, unknown>,
  idempotencyKey: string | null,
  providers: AiProvider[],
  testEnabled: boolean,
  maxAttempts: number,
): Promise<TaskDraft> {
  const parsed = parseTaskBody(body, testEnabled);
  const owner = await ownerFor(client, actorUserId, body.organizationId);
  await assertCanActForOwner(client, actorUserId, owner);
  if (parsed.input.designProjectId) {
    await requireProject(client, actorUserId, parsed.input.designProjectId);
  }
  for (const mediaId of parsed.input.mediaIds) {
    const media = await requireMedia(client, actorUserId, mediaId);
    if (
      media.variant !== "original" ||
      media.status !== "ready" ||
      media.mediaType !== "image" ||
      !imageMimes.has(media.mimeType)
    ) {
      throw invalid("invalid_media", "An input image must be a ready JPEG, PNG, or WebP original.");
    }
  }
  const provider = selectProvider(providers, parsed.capability);
  if (!provider) throw invalid("capability_unavailable", "No provider is configured for this capability.");
  return {
    actorUserId,
    owner,
    capability: parsed.capability,
    input: parsed.input,
    fingerprint: fingerprint(parsed.capability, owner.organizationId ?? null, parsed.input),
    idempotencyKey,
    providerId: provider.id,
    simulated: provider.simulated,
    maxAttempts,
  };
}

export async function insertTask(client: PoolClient, draft: TaskDraft): Promise<TaskView> {
  const columns = ownerColumns(draft.owner);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ai_tasks (
       capability, owner_user_id, owner_organization_id, created_by_user_id, design_project_id,
       idempotency_key, input_fingerprint, input, provider_id, simulated, max_attempts
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
     RETURNING id`,
    [
      draft.capability,
      columns.ownerUserId,
      columns.ownerOrganizationId,
      draft.actorUserId,
      draft.input.designProjectId,
      draft.idempotencyKey,
      draft.fingerprint,
      JSON.stringify({
        mediaIds: draft.input.mediaIds,
        designProjectId: draft.input.designProjectId,
        outcome: draft.input.outcome,
        note: draft.input.note,
      }),
      draft.providerId,
      draft.simulated,
      draft.maxAttempts,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_body", "Task could not be saved.");
  for (let index = 0; index < draft.input.mediaIds.length; index += 1) {
    await client.query(
      `INSERT INTO ai_task_inputs (task_id, media_id, position) VALUES ($1, $2, $3)`,
      [id, draft.input.mediaIds[index], index + 1],
    );
  }
  await addEvent(client, id, "accepted", "Task accepted.");
  const task = await loadTask(client, draft.actorUserId, id);
  if (!task) throw notFound("Task was not found.");
  return task;
}

export async function replayTask(
  client: PoolClient,
  draft: TaskDraft,
): Promise<{ task: TaskView; matches: boolean } | null> {
  if (!draft.idempotencyKey) return null;
  const found = await client.query<{ id: string; input_fingerprint: string }>(
    `SELECT id, input_fingerprint
     FROM ai_tasks
     WHERE created_by_user_id = $1 AND idempotency_key = $2`,
    [draft.actorUserId, draft.idempotencyKey],
  );
  const row = found.rows[0];
  if (!row) return null;
  const task = await loadTask(client, draft.actorUserId, row.id);
  if (!task) return null;
  return { task, matches: row.input_fingerprint === draft.fingerprint };
}

export async function listTasks(
  client: PoolClient,
  actorUserId: string,
  query: { limit: number; offset: number; status?: string },
): Promise<{ tasks: TaskView[]; total: number }> {
  const params: unknown[] = [];
  const actor = bind(params, actorUserId);
  const where = [visibleSql(actor)];
  if (query.status) where.push(`task.status = ${bind(params, query.status)}`);
  const whereSql = where.join(" AND ");
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM ai_tasks AS task WHERE ${whereSql}`,
    params,
  );
  const pageParams = [...params];
  const limit = bind(pageParams, query.limit);
  const offset = bind(pageParams, query.offset);
  const page = await client.query<{ id: string }>(
    `SELECT task.id FROM ai_tasks AS task
     WHERE ${whereSql}
     ORDER BY task.created_at DESC, task.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    pageParams,
  );
  const tasks: TaskView[] = [];
  for (const row of page.rows) {
    const task = await loadTask(client, actorUserId, row.id);
    if (task) tasks.push(task);
  }
  return { tasks, total: Number(total.rows[0]?.total ?? 0) };
}

export async function requireTask(client: PoolClient, actorUserId: string, taskId: string): Promise<TaskView> {
  const task = await loadTask(client, actorUserId, taskId);
  if (!task) throw notFound("Task was not found.");
  return task;
}

export async function cancelTask(client: PoolClient, actorUserId: string, taskId: string): Promise<TaskView> {
  const locked = await client.query<TaskRow>(
    `SELECT id, capability, status, simulated, attempt_count, max_attempts, design_project_id,
            error_category, error_message, provider_id, model_id, created_at, started_at, completed_at,
            owner_user_id, owner_organization_id, input_fingerprint
     FROM ai_tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  const row = locked.rows[0];
  if (!row) throw notFound("Task was not found.");
  const allowed = await canRead(client, actorUserId, row);
  if (!allowed) throw notFound("Task was not found.");
  await assertCanActForOwner(client, actorUserId, ownerFromIds(row.owner_user_id, row.owner_organization_id));
  if (row.status === "running") {
    throw invalid("cancel_unsupported", "A running task cannot be cancelled. Provider cancellation is not available.");
  }
  if (row.status !== "queued") throw invalid("invalid_transition", "That status change is not allowed.");
  await client.query(
    `UPDATE ai_tasks
     SET status = 'cancelled', completed_at = now(), locked_by = NULL, locked_at = NULL
     WHERE id = $1 AND status = 'queued'`,
    [taskId],
  );
  await addEvent(client, taskId, "cancelled", "Task cancelled.");
  return requireTask(client, actorUserId, taskId);
}

export function capabilityReport(providers: AiProvider[], testEnabled: boolean): CapabilityView[] {
  return listCapabilities(providers, testEnabled);
}

export async function addEvent(
  client: PoolClient,
  taskId: string,
  kind: string,
  message: string,
): Promise<void> {
  await client.query(`INSERT INTO ai_task_events (task_id, kind, message) VALUES ($1, $2, $3)`, [taskId, kind, message]);
}

async function loadTask(client: PoolClient, actorUserId: string, taskId: string): Promise<TaskView | null> {
  const params: unknown[] = [taskId];
  const actor = bind(params, actorUserId);
  const found = await client.query<TaskRow>(
    `SELECT task.id, task.capability, task.status, task.simulated, task.attempt_count, task.max_attempts,
            task.design_project_id, task.error_category, task.error_message, task.provider_id, task.model_id,
            task.created_at, task.started_at, task.completed_at, task.owner_user_id, task.owner_organization_id,
            task.input_fingerprint
     FROM ai_tasks AS task
     WHERE task.id = $1 AND ${visibleSql(actor)}`,
    params,
  );
  const row = found.rows[0];
  if (!row) return null;
  const media = await client.query<{ media_id: string }>(
    `SELECT media_id FROM ai_task_inputs WHERE task_id = $1 ORDER BY position`,
    [taskId],
  );
  const events = await client.query<{ kind: string; message: string; created_at: Date }>(
    `SELECT kind, message, created_at FROM ai_task_events WHERE task_id = $1 ORDER BY created_at, id`,
    [taskId],
  );
  const output = await client.query<{
    provider_id: string;
    model_id: string | null;
    simulated: boolean;
    summary: string;
    media_id: string | null;
    source: string | null;
    input_units: number | null;
    output_units: number | null;
    image_count: number | null;
    duration_ms: number | null;
    estimated_cost_minor: number | null;
    currency: string | null;
  }>(
    `SELECT output.provider_id, output.model_id, output.simulated, output.summary, output.media_id,
            usage.source, usage.input_units, usage.output_units, usage.image_count, usage.duration_ms,
            usage.estimated_cost_minor, usage.currency
     FROM ai_task_outputs AS output
     LEFT JOIN ai_usage_records AS usage ON usage.attempt_id = output.attempt_id
     WHERE output.task_id = $1
     ORDER BY output.created_at DESC
     LIMIT 1`,
    [taskId],
  );
  const result = output.rows[0];
  return {
    id: row.id,
    capability: row.capability,
    status: row.status,
    simulated: row.simulated,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    designProjectId: row.design_project_id,
    mediaIds: media.rows.map((item) => item.media_id),
    error:
      row.error_category && row.error_message ? { category: row.error_category, message: row.error_message } : null,
    result: result
      ? {
          simulated: result.simulated,
          providerId: result.provider_id,
          modelId: result.model_id,
          summary: result.summary,
          media: result.media_id ? { id: result.media_id } : null,
          usage: {
            source: result.source ?? "unreported",
            inputUnits: result.input_units == null ? null : Number(result.input_units),
            outputUnits: result.output_units == null ? null : Number(result.output_units),
            imageCount: result.image_count == null ? null : Number(result.image_count),
            durationMs: result.duration_ms == null ? null : Number(result.duration_ms),
            estimatedCost: result.estimated_cost_minor == null ? null : Number(result.estimated_cost_minor),
            currency: result.currency,
          },
        }
      : null,
    events: events.rows.map((event) => ({
      kind: event.kind,
      message: event.message,
      createdAt: new Date(event.created_at).toISOString(),
    })),
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

async function ownerFor(client: PoolClient, actorUserId: string, organizationId: unknown): Promise<OwnerRef> {
  if (organizationId === undefined) return { userId: actorUserId };
  if (typeof organizationId !== "string") throw invalid("invalid_owner", "Organization was not found.");
  const id = organizationId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw invalid("invalid_owner", "Organization was not found.");
  }
  const organization = await client.query<{ status: string }>(`SELECT status FROM organizations WHERE id = $1`, [id]);
  if (organization.rows[0]?.status !== "active") throw invalid("invalid_owner", "Organization is not active.");
  return { organizationId: id };
}

async function canRead(client: PoolClient, actorUserId: string, row: TaskRow): Promise<boolean> {
  const params: unknown[] = [row.id];
  const actor = bind(params, actorUserId);
  const found = await client.query(
    `SELECT 1 FROM ai_tasks AS task WHERE task.id = $1 AND ${visibleSql(actor)}`,
    params,
  );
  return Boolean(found.rowCount);
}

function fingerprint(capability: string, organizationId: string | null, input: NormalizedInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        capability,
        organizationId,
        mediaIds: input.mediaIds,
        designProjectId: input.designProjectId,
        outcome: input.outcome,
        note: input.note,
      }),
    )
    .digest("hex");
}

function visibleSql(actor: string): string {
  return `(
    ${actor}::uuid IS NOT NULL AND (
      task.owner_user_id = ${actor}::uuid
      OR EXISTS (
        SELECT 1 FROM organization_memberships AS membership
        WHERE membership.organization_id = task.owner_organization_id
          AND membership.user_id = ${actor}::uuid
          AND membership.status = 'active'
      )
    )
  )`;
}

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}
