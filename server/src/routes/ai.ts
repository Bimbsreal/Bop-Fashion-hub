import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, pageLimit, pageOffset, requireUuid } from "../http/body";
import { createRateLimiter } from "../http/upload-limit";
import type { AiSettings } from "../modules/ai-settings";
import { cancelTask, capabilityReport, insertTask, listTasks, prepareTask, replayTask, requireTask } from "../modules/ai-tasks";

const taskStatuses = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

export function aiRouter(settings: AiSettings) {
  const router = Router();
  const limitTasks = createRateLimiter(settings.maxTasksPerMinute, "Too many AI tasks. Try again shortly.");

  router.get("/capabilities", async (_request, response) => {
    requireUser(response);
    response.json({ capabilities: capabilityReport(settings.providers, settings.testEnabled) });
  });

  router.post("/tasks", async (request, response) => {
    const actorUserId = requireUser(response);
    limitTasks(actorUserId);
    const body = objectBody(request.body);
    const idempotencyKey = idempotencyHeader(request.header("idempotency-key"));
    const draft = await withTransaction((client) =>
      prepareTask(client, actorUserId, body, idempotencyKey, settings.providers, settings.testEnabled, settings.maxAttempts),
    );
    try {
      const task = await withTransaction((client) => insertTask(client, draft));
      response.status(202).json({ task });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await withTransaction((client) => replayTask(client, draft));
      if (!replay?.matches) throw invalid("conflict", "Idempotency key was already used.");
      response.status(200).json({ task: replay.task });
    }
  });

  router.get("/tasks", async (request, response) => {
    const actorUserId = requireUser(response);
    const limit = pageLimit(request.query.limit);
    const offset = pageOffset(request.query.offset);
    const status = optionalStatus(request.query.status);
    const page = await withTransaction((client) => listTasks(client, actorUserId, { limit, offset, status }));
    response.json({ tasks: page.tasks, page: { limit, offset, total: page.total } });
  });

  router.post("/tasks/:id/cancel", async (request, response) => {
    const actorUserId = requireUser(response);
    const task = await withTransaction((client) => cancelTask(client, actorUserId, pathId(request.params.id)));
    response.json({ task });
  });

  router.get("/tasks/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const task = await withTransaction((client) => requireTask(client, actorUserId, pathId(request.params.id)));
    response.json({ task });
  });

  return router;
}

function idempotencyHeader(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) throw invalid("invalid_body", "Idempotency key is not valid.");
  return key;
}

function optionalStatus(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !taskStatuses.has(value)) throw invalid("invalid_status", "Task status is not recognized.");
  return value;
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505";
}
