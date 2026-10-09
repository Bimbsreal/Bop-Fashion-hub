import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import sharp from "sharp";
import { createApp } from "../src/app";
import { readConfig } from "../src/config";
import { migrate } from "../src/db/migrate";
import { closePool, getPool, withTransaction } from "../src/db/pool";
import { resolveAiSettings, type AiSettings } from "../src/modules/ai-settings";
import type { TestProvider } from "../src/modules/ai-test-provider";
import { runWorkerOnce } from "../src/modules/ai-worker";
import { addMember, createOrganization } from "../src/modules/organizations";
import { localMediaStorage } from "../src/modules/storage";

const password = "ai-pass-1";
const storageDir = path.resolve(".local/media-ai-test");
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";
let ai: AiSettings;

type Task = {
  id: string;
  capability: string;
  status: string;
  simulated: boolean;
  attemptCount: number;
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
  events: { kind: string; message: string }[];
};

type Capability = {
  id: string;
  registered: boolean;
  configured: boolean;
  available: boolean;
  operational: boolean;
  simulated: boolean;
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so AI tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so AI tests were not executed.");
  await migrate(pool);
  await removeAiFixtures(pool);
  await rm(storageDir, { recursive: true, force: true });
  ai = resolveAiSettings(readConfig(), {
    testProvider: true,
    maxAttempts: 3,
    timeoutMs: 50,
    backoffMs: 0,
    staleRunningMs: 60_000,
    maxTasksPerMinute: 30,
  });
  server = createApp({ storage: localMediaStorage(storageDir), ai }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeAiFixtures(pool);
  await rm(storageDir, { recursive: true, force: true });
  await closePool();
});

test("fashion capabilities stay registered and not operational, and an unconfigured provider rejects work", async () => {
  const listed = await request("GET", "/api/v1/ai/capabilities", { cookie: (await register("Registry")).cookie });
  const capabilities = (listed.body as { capabilities: Capability[] }).capabilities;
  const analysis = capabilities.find((item) => item.id === "fashion.image_analysis");
  const simulated = capabilities.find((item) => item.id === "test.orchestration");
  assert.equal(analysis?.registered, true);
  assert.equal(analysis?.configured, false);
  assert.equal(analysis?.available, false);
  assert.equal(analysis?.operational, false);
  assert.equal(analysis?.simulated, false);
  assert.equal(simulated?.simulated, true);
  assert.equal(simulated?.operational, false);
  assert.equal(simulated?.configured, true);

  const quiet = resolveAiSettings(readConfig(), { testProvider: false, maxTasksPerMinute: 10 });
  const quietServer = createApp({ storage: localMediaStorage(storageDir), ai: quiet }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => quietServer.once("listening", () => resolve()));
  const quietUrl = `http://127.0.0.1:${(quietServer.address() as AddressInfo).port}`;
  try {
    const owner = await registerOn(quietUrl, "Quiet");
    const quietList = await requestOn(quietUrl, "GET", "/api/v1/ai/capabilities", { cookie: owner.cookie });
    const ids = (quietList.body as { capabilities: Capability[] }).capabilities.map((item) => item.id);
    assert.equal(ids.includes("test.orchestration"), false);
    assert.equal(ids.includes("fashion.virtual_try_on"), true);
    const hidden = await requestOn(quietUrl, "POST", "/api/v1/ai/tasks", {
      cookie: owner.cookie,
      body: { capability: "test.orchestration", outcome: "succeed" },
    });
    assert.equal(hidden.status, 400);
    assert.equal((hidden.body as { error: { code: string } }).error.code, "invalid_capability");
    const project = await requestOn(quietUrl, "POST", "/api/v1/design-projects", {
      cookie: owner.cookie,
      body: { name: "Unavailable study" },
    });
    const projectId = (project.body as { project: { id: string } }).project.id;
    const unavailable = await requestOn(quietUrl, "POST", "/api/v1/ai/tasks", {
      cookie: owner.cookie,
      body: { capability: "fashion.design_generation", designProjectId: projectId, note: "A sleeve study" },
    });
    assert.equal(unavailable.status, 400);
    assert.equal((unavailable.body as { error: { code: string } }).error.code, "capability_unavailable");
    const tasks = await requestOn(quietUrl, "GET", "/api/v1/ai/tasks", { cookie: owner.cookie });
    assert.equal((tasks.body as { page: { total: number } }).page.total, 0);
  } finally {
    await new Promise<void>((resolve, reject) => quietServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("submission validates inputs, ownership, and leaves execution queued", async () => {
  const owner = await register("Maker");
  const other = await register("Other");
  const anonymous = await request("POST", "/api/v1/ai/tasks", { body: { capability: "test.orchestration", outcome: "succeed" } });
  assert.equal(anonymous.status, 401);
  const unknown = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "fashion.unknown", mediaIds: [] },
  });
  assert.equal(unknown.status, 400);
  const privileged = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed", provider: "secret" },
  });
  assert.equal(privileged.status, 400);

  const foreignGarment = await request("POST", "/api/v1/catalog/garments", {
    cookie: other.cookie,
    body: { name: "Private cloth" },
  });
  const foreignGarmentId = (foreignGarment.body as { garment: { id: string } }).garment.id;
  const foreignMedia = await request("POST", `/api/v1/catalog/garments/${foreignGarmentId}/media`, {
    cookie: other.cookie,
    body: {
      role: "reference",
      mediaType: "image",
      mimeType: "image/png",
      byteSize: 12,
      storageKey: `ai/${randomUUID()}.png`,
    },
  });
  const foreignMediaId = (foreignMedia.body as { garment: { media: { id: string }[] } }).garment.media[0]?.id;
  const denied = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed", mediaIds: [foreignMediaId] },
  });
  assert.equal(denied.status, 404);

  const ownGarment = await request("POST", "/api/v1/catalog/garments", { cookie: owner.cookie, body: { name: "Pending cloth" } });
  const ownGarmentId = (ownGarment.body as { garment: { id: string } }).garment.id;
  const pending = await request("POST", `/api/v1/catalog/garments/${ownGarmentId}/media`, {
    cookie: owner.cookie,
    body: {
      role: "sketch",
      mediaType: "image",
      mimeType: "image/png",
      byteSize: 12,
      storageKey: `ai/${randomUUID()}.png`,
    },
  });
  const pendingId = (pending.body as { garment: { media: { id: string }[] } }).garment.media[0]?.id;
  const notReady = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed", mediaIds: [pendingId] },
  });
  assert.equal(notReady.status, 400);
  assert.equal((notReady.body as { error: { code: string } }).error.code, "invalid_media");

  const project = await request("POST", "/api/v1/design-projects", { cookie: owner.cookie, body: { name: "Try on later" } });
  const projectId = (project.body as { project: { id: string; media: unknown[] } }).project.id;
  const tryOn = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "fashion.virtual_try_on", designProjectId: projectId, mediaIds: [pendingId] },
  });
  assert.equal(tryOn.status, 400);

  const imageId = await uploadPng(owner.cookie);
  const thumbnail = await request("GET", `/api/v1/media/${imageId}`, { cookie: owner.cookie });
  const thumbnailId = (thumbnail.body as { media: { thumbnailId: string } }).media.thumbnailId;
  const thumbnailDenied = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed", mediaIds: [thumbnailId] },
  });
  assert.equal(thumbnailDenied.status, 400);
  assert.equal((thumbnailDenied.body as { error: { code: string } }).error.code, "invalid_media");

  const created = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    headers: { "idempotency-key": "maker-task-1" },
    body: { capability: "test.orchestration", outcome: "succeed", mediaIds: [imageId], designProjectId: projectId },
  });
  assert.equal(created.status, 202);
  const task = (created.body as { task: Task }).task;
  assert.equal(task.status, "queued");
  assert.equal(task.simulated, true);
  assert.equal(task.mediaIds[0], imageId);
  assert.equal(JSON.stringify(created.body).includes("storageKey"), false);
  const replay = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    headers: { "idempotency-key": "maker-task-1" },
    body: { capability: "test.orchestration", outcome: "succeed", mediaIds: [imageId], designProjectId: projectId },
  });
  assert.equal(replay.status, 200);
  assert.equal((replay.body as { task: Task }).task.id, task.id);
  const conflict = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    headers: { "idempotency-key": "maker-task-1" },
    body: { capability: "test.orchestration", outcome: "permanent_failure", mediaIds: [imageId], designProjectId: projectId },
  });
  assert.equal(conflict.status, 409);

  const stranger = await request("GET", `/api/v1/ai/tasks/${task.id}`, { cookie: other.cookie });
  assert.equal(stranger.status, 404);
  const signedOut = await request("GET", `/api/v1/ai/tasks/${task.id}`);
  assert.equal(signedOut.status, 401);

  assert.ok(pool);
  const ran = await runWorkerOnce(pool, ai);
  assert.equal(ran.taskId, task.id);
  const again = await runWorkerOnce(pool, ai);
  assert.equal(again.taskId, null);
  const finished = await request("GET", `/api/v1/ai/tasks/${task.id}`, { cookie: owner.cookie });
  const done = (finished.body as { task: Task }).task;
  assert.equal(done.status, "succeeded");
  assert.equal(done.attemptCount, 1);
  assert.equal(done.result?.simulated, true);
  assert.equal(done.result?.providerId, "test");
  assert.equal(done.result?.modelId, null);
  assert.equal(done.result?.media, null);
  assert.equal(done.result?.usage.source, "unreported");
  assert.equal(done.result?.usage.inputUnits, null);
  assert.equal(done.result?.usage.estimatedCost, null);
  assert.equal(done.result?.summary.includes("No AI model was called"), true);
  assert.equal(done.events.some((event) => event.kind === "accepted"), true);
  assert.equal(done.events.some((event) => event.kind === "completed"), true);
  const projectAfter = await request("GET", `/api/v1/design-projects/${projectId}`, { cookie: owner.cookie });
  assert.equal((projectAfter.body as { project: { media: unknown[] } }).project.media.length, 0);
  const cancelled = await request("POST", `/api/v1/ai/tasks/${task.id}/cancel`, { cookie: owner.cookie });
  assert.equal(cancelled.status, 400);
});

test("organization tasks stay inside the organization", async () => {
  assert.ok(pool);
  const owner = await register("Studio");
  const member = await register("Member");
  const outsider = await register("Outsider");
  const slug = `ai-test-${randomUUID().slice(0, 8)}`;
  const organization = await withTransaction((client) =>
    createOrganization(client, owner.id, { name: "AI Studio", slug, kind: "studio" }),
  );
  await withTransaction((client) =>
    addMember(client, owner.id, { organizationId: organization.id, userId: member.id, role: "member" }),
  );
  const created = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed", organizationId: organization.id },
  });
  assert.equal(created.status, 202);
  const taskId = (created.body as { task: Task }).task.id;
  const seen = await request("GET", `/api/v1/ai/tasks/${taskId}`, { cookie: member.cookie });
  assert.equal(seen.status, 200);
  const hidden = await request("GET", `/api/v1/ai/tasks/${taskId}`, { cookie: outsider.cookie });
  assert.equal(hidden.status, 404);
  const listed = await request("GET", "/api/v1/ai/tasks?limit=1", { cookie: member.cookie });
  assert.equal((listed.body as { tasks: Task[]; page: { total: number } }).page.total >= 1, true);
  await runWorkerOnce(pool, ai);
});

test("retries stop at the attempt limit and permanent failures do not retry", async () => {
  assert.ok(pool);
  const owner = await register("Retries");
  const provider = ai.providers[0] as TestProvider;
  const mark = provider.idempotencyKeys.length;
  const temporary = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "temporary_failure" },
  });
  const temporaryId = (temporary.body as { task: Task }).task.id;
  for (let attempt = 0; attempt < 3; attempt += 1) await runWorkerOnce(pool, ai);
  const failed = await request("GET", `/api/v1/ai/tasks/${temporaryId}`, { cookie: owner.cookie });
  const temporaryTask = (failed.body as { task: Task }).task;
  assert.equal(temporaryTask.status, "failed");
  assert.equal(temporaryTask.attemptCount, 3);
  assert.equal(temporaryTask.error?.category, "temporary_network");
  assert.equal(temporaryTask.events.filter((event) => event.kind === "retry_scheduled").length, 2);
  assert.equal(temporaryTask.events.some((event) => event.kind === "permanently_failed"), true);
  const keys = provider.idempotencyKeys.slice(mark);
  assert.deepEqual(keys, [temporaryId, temporaryId, temporaryId]);

  const permanent = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "permanent_failure" },
  });
  const permanentId = (permanent.body as { task: Task }).task.id;
  await runWorkerOnce(pool, ai);
  const once = await request("GET", `/api/v1/ai/tasks/${permanentId}`, { cookie: owner.cookie });
  const permanentTask = (once.body as { task: Task }).task;
  assert.equal(permanentTask.status, "failed");
  assert.equal(permanentTask.attemptCount, 1);
  assert.equal(permanentTask.error?.category, "permanent");
  assert.equal(permanentTask.events.some((event) => event.kind === "retry_scheduled"), false);

  const unsupported = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "unsupported" },
  });
  const unsupportedId = (unsupported.body as { task: Task }).task.id;
  await runWorkerOnce(pool, ai);
  const unsupportedTask = (
    await request("GET", `/api/v1/ai/tasks/${unsupportedId}`, { cookie: owner.cookie })
  ).body as { task: Task };
  assert.equal(unsupportedTask.task.error?.category, "unsupported_capability");
  assert.equal(unsupportedTask.task.attemptCount, 1);
});

test("timeouts, cancellation, stale work, and concurrent claims stay inside the lifecycle", async () => {
  assert.ok(pool);
  const owner = await register("Lifecycle");
  const reported = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "timeout" },
  });
  const reportedId = (reported.body as { task: Task }).task.id;
  for (let attempt = 0; attempt < 3; attempt += 1) await runWorkerOnce(pool, ai);
  const reportedTask = (await request("GET", `/api/v1/ai/tasks/${reportedId}`, { cookie: owner.cookie })).body as {
    task: Task;
  };
  assert.equal(reportedTask.task.error?.message, "Simulated timeout.");
  assert.equal(reportedTask.task.status, "failed");

  const hanging = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "hang" },
  });
  const hangingId = (hanging.body as { task: Task }).task.id;
  for (let attempt = 0; attempt < 3; attempt += 1) await runWorkerOnce(pool, ai);
  const hangingTask = (await request("GET", `/api/v1/ai/tasks/${hangingId}`, { cookie: owner.cookie })).body as {
    task: Task;
  };
  assert.equal(hangingTask.task.error?.message, "The attempt timed out.");
  assert.equal(hangingTask.task.attemptCount, 3);

  const queued = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed" },
  });
  const queuedId = (queued.body as { task: Task }).task.id;
  const cancelled = await request("POST", `/api/v1/ai/tasks/${queuedId}/cancel`, { cookie: owner.cookie });
  assert.equal((cancelled.body as { task: Task }).task.status, "cancelled");
  const skipped = await runWorkerOnce(pool, ai);
  assert.equal(skipped.taskId, null);

  const running = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed" },
  });
  const runningId = (running.body as { task: Task }).task.id;
  await pool.query(
    `UPDATE ai_tasks SET status = 'running', attempt_count = 1, locked_at = now(), locked_by = 'held' WHERE id = $1`,
    [runningId],
  );
  const cannotCancel = await request("POST", `/api/v1/ai/tasks/${runningId}/cancel`, { cookie: owner.cookie });
  assert.equal(cannotCancel.status, 409);
  assert.equal((cannotCancel.body as { error: { code: string } }).error.code, "cancel_unsupported");
  await pool.query(`UPDATE ai_tasks SET status = 'failed', completed_at = now() WHERE id = $1`, [runningId]);

  const stale = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed" },
  });
  const staleId = (stale.body as { task: Task }).task.id;
  await pool.query(
    `UPDATE ai_tasks
     SET status = 'running', attempt_count = 3, locked_at = now() - interval '2 hours', locked_by = 'stale'
     WHERE id = $1`,
    [staleId],
  );
  const recovered = await runWorkerOnce(pool, ai);
  assert.equal(recovered.taskId, null);
  const staleTask = (await request("GET", `/api/v1/ai/tasks/${staleId}`, { cookie: owner.cookie })).body as { task: Task };
  assert.equal(staleTask.task.status, "failed");
  assert.equal(staleTask.task.attemptCount, 3);
  assert.equal(staleTask.task.error?.message, "The attempt stopped before it finished.");

  const resumed = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed" },
  });
  const resumedId = (resumed.body as { task: Task }).task.id;
  await pool.query(
    `UPDATE ai_tasks
     SET status = 'running', attempt_count = 1, locked_at = now() - interval '2 hours', locked_by = 'stale'
     WHERE id = $1`,
    [resumedId],
  );
  const resumedRun = await runWorkerOnce(pool, ai);
  assert.equal(resumedRun.taskId, resumedId);
  const resumedTask = (await request("GET", `/api/v1/ai/tasks/${resumedId}`, { cookie: owner.cookie })).body as {
    task: Task;
  };
  assert.equal(resumedTask.task.status, "succeeded");
  assert.equal(resumedTask.task.attemptCount, 2);
  assert.equal(
    resumedTask.task.events.some((event) => event.message === "Stale attempt returned to the queue."),
    true,
  );

  const first = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed" },
  });
  const second = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "test.orchestration", outcome: "succeed" },
  });
  const [left, right] = await Promise.all([runWorkerOnce(pool, ai), runWorkerOnce(pool, ai)]);
  const claimed = [left.taskId, right.taskId].sort();
  const expected = [(first.body as { task: Task }).task.id, (second.body as { task: Task }).task.id].sort();
  assert.deepEqual(claimed, expected);
});

test("task submission is rate limited per signed-in user", async () => {
  const limited = resolveAiSettings(readConfig(), { testProvider: true, maxTasksPerMinute: 2, backoffMs: 0 });
  const limitedServer = createApp({ storage: localMediaStorage(storageDir), ai: limited }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => limitedServer.once("listening", () => resolve()));
  const limitedUrl = `http://127.0.0.1:${(limitedServer.address() as AddressInfo).port}`;
  try {
    const owner = await registerOn(limitedUrl, "Limited");
    const first = await requestOn(limitedUrl, "POST", "/api/v1/ai/tasks", {
      cookie: owner.cookie,
      body: { capability: "test.orchestration", outcome: "succeed" },
    });
    const second = await requestOn(limitedUrl, "POST", "/api/v1/ai/tasks", {
      cookie: owner.cookie,
      body: { capability: "test.orchestration", outcome: "succeed" },
    });
    const third = await requestOn(limitedUrl, "POST", "/api/v1/ai/tasks", {
      cookie: owner.cookie,
      body: { capability: "test.orchestration", outcome: "succeed" },
    });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(third.status, 429);
    await requestOn(limitedUrl, "POST", `/api/v1/ai/tasks/${(first.body as { task: Task }).task.id}/cancel`, {
      cookie: owner.cookie,
    });
    await requestOn(limitedUrl, "POST", `/api/v1/ai/tasks/${(second.body as { task: Task }).task.id}/cancel`, {
      cookie: owner.cookie,
    });
  } finally {
    await new Promise<void>((resolve, reject) => limitedServer.close((error) => (error ? reject(error) : resolve())));
  }
});

async function uploadPng(cookie: string): Promise<string> {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#112233" } }).png().toBuffer();
  const response = await fetch(`${baseUrl}/api/v1/media?visibility=private`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-original-filename": "swatch.png" },
    body: new Uint8Array(bytes),
  });
  const body = (await response.json()) as { media: { id: string } };
  assert.equal(response.status, 201);
  return body.media.id;
}

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  return registerOn(baseUrl, displayName);
}

async function registerOn(url: string, displayName: string): Promise<{ id: string; cookie: string }> {
  const response = await requestOn(url, "POST", "/api/v1/auth/register", {
    body: { email: `${randomUUID()}@ai.test`, displayName, password },
  });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, cookie: `bop_session=${token[1]}` };
}

async function request(method: string, path: string, options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return requestOn(baseUrl, method, path, options);
}

async function requestOn(
  url: string,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : null };
}

async function removeAiFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@ai.test')`;
  const orgs = `(SELECT id FROM organizations WHERE slug LIKE 'ai-test-%')`;
  await active.query(
    `DELETE FROM ai_tasks
     WHERE owner_user_id IN ${owners}
        OR created_by_user_id IN ${owners}
        OR owner_organization_id IN ${orgs}`,
  );
  await active.query(
    `DELETE FROM design_projects
     WHERE owner_user_id IN ${owners}
        OR created_by_user_id IN ${owners}
        OR owner_organization_id IN ${orgs}`,
  );
  const garments = `(SELECT id FROM garments WHERE owner_user_id IN ${owners} OR created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`;
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garments WHERE id IN ${garments}`);
  await active.query(
    `DELETE FROM media_assets WHERE variant = 'thumbnail' AND (owner_user_id IN ${owners} OR owner_organization_id IN ${orgs})`,
  );
  await active.query(`DELETE FROM media_assets WHERE owner_user_id IN ${owners} OR owner_organization_id IN ${orgs}`);
  await active.query(`DELETE FROM organization_memberships WHERE user_id IN ${owners} OR organization_id IN ${orgs}`);
  await active.query(`DELETE FROM organizations WHERE slug LIKE 'ai-test-%'`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@ai.test'`);
}
