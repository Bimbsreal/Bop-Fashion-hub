import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, pageLimit, pageOffset, requireUuid } from "../http/body";
import { createRateLimiter } from "../http/upload-limit";
import type { AiSettings } from "../modules/ai-settings";
import { cancelTask, insertTask, prepareTask, replayTask } from "../modules/ai-tasks";
import { applyAnalysis, createAnalysisShell, listAnalyses, requireAnalysis, reviewAttribute } from "../modules/garment-analysis";

export function analysesRouter(settings: AiSettings) {
  const router = Router();
  const limitTasks = createRateLimiter(settings.maxTasksPerMinute, "Too many AI tasks. Try again shortly.");

  router.post("/", async (request, response) => {
    const actorUserId = requireUser(response);
    limitTasks(actorUserId);
    const body = objectBody(request.body);
    rejectExternalImage(body);
    const mediaId = requireUuid(requiredMedia(body.mediaId), "not_found");
    const taskBody: Record<string, unknown> = {
      capability: "fashion.garment_attribute_extraction",
      mediaIds: [mediaId],
    };
    if (body.organizationId !== undefined) taskBody.organizationId = body.organizationId;
    if (settings.testEnabled && body.outcome !== undefined) taskBody.outcome = body.outcome;
    if (!settings.testEnabled && body.outcome !== undefined) {
      throw invalid("invalid_body", "Unrecognized task field.");
    }
    const idempotencyKey = idempotencyHeader(request.header("idempotency-key"));
    const draft = await withTransaction((client) =>
      prepareTask(client, actorUserId, taskBody, idempotencyKey, settings.providers, settings.testEnabled, settings.maxAttempts),
    );
    try {
      const created = await withTransaction(async (client) => {
        const task = await insertTask(client, draft);
        const analysisId = await createAnalysisShell(client, {
          taskId: task.id,
          mediaId,
          providerId: draft.providerId,
          simulated: draft.simulated,
        });
        return requireAnalysis(client, actorUserId, analysisId);
      });
      response.status(202).json({ analysis: created });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await withTransaction((client) => replayTask(client, draft));
      if (!replay?.matches) throw invalid("conflict", "Idempotency key was already used.");
      const analysis = await withTransaction((client) => analysisForTask(client, actorUserId, replay.task.id, mediaId, draft));
      response.status(200).json({ analysis });
    }
  });

  router.get("/", async (request, response) => {
    const actorUserId = requireUser(response);
    const limit = pageLimit(request.query.limit);
    const offset = pageOffset(request.query.offset);
    const page = await withTransaction((client) => listAnalyses(client, actorUserId, { limit, offset }));
    response.json({ analyses: page.analyses, page: { limit, offset, total: page.total } });
  });

  router.get("/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const analysis = await withTransaction((client) => requireAnalysis(client, actorUserId, pathId(request.params.id)));
    response.json({ analysis });
  });

  router.post("/:id/cancel", async (request, response) => {
    const actorUserId = requireUser(response);
    const analysis = await withTransaction(async (client) => {
      const current = await requireAnalysis(client, actorUserId, pathId(request.params.id));
      await cancelTask(client, actorUserId, current.taskId);
      return requireAnalysis(client, actorUserId, current.id);
    });
    response.json({ analysis });
  });

  router.patch("/:id/attributes/:key", async (request, response) => {
    const actorUserId = requireUser(response);
    const analysis = await withTransaction((client) =>
      reviewAttribute(client, actorUserId, pathId(request.params.id), pathKey(request.params.key), objectBody(request.body)),
    );
    response.json({ analysis });
  });

  router.post("/:id/apply", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    const garmentId = requireUuid(requiredId(body.garmentId, "Garment is required."), "not_found");
    const replaceKinds = kindList(body.replaceKinds);
    const analysis = await withTransaction((client) =>
      applyAnalysis(client, actorUserId, pathId(request.params.id), garmentId, replaceKinds),
    );
    response.json({ analysis });
  });

  return router;
}

async function analysisForTask(
  client: Parameters<typeof createAnalysisShell>[0],
  actorUserId: string,
  taskId: string,
  mediaId: string,
  draft: { providerId: string; simulated: boolean },
) {
  const analysisId = await createAnalysisShell(client, {
    taskId,
    mediaId,
    providerId: draft.providerId,
    simulated: draft.simulated,
  });
  return requireAnalysis(client, actorUserId, analysisId);
}

function rejectExternalImage(body: Record<string, unknown>) {
  for (const key of ["url", "imageUrl", "href", "src", "provider", "providerId", "model", "apiKey"]) {
    if (key in body) throw invalid("invalid_body", "Use an existing media asset.");
  }
}

function requiredMedia(value: unknown): string {
  return requiredId(value, "Media is required.");
}

function requiredId(value: unknown, message: string): string {
  if (typeof value !== "string") throw invalid("invalid_body", message);
  return value;
}

function kindList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("invalid_body", "Replace list is not valid.");
  return value.map((item) => {
    if (typeof item !== "string" || !/^[a-z_]+$/.test(item)) throw invalid("invalid_body", "Replace list is not valid.");
    return item;
  });
}

function idempotencyHeader(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) throw invalid("invalid_body", "Idempotency key is not valid.");
  return key;
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function pathKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !/^[a-z_]+$/.test(value)) throw invalid("invalid_attribute", "Attribute is not recognized.");
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505";
}
