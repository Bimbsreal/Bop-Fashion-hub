import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import {
  objectBody,
  optionalString,
  optionalVisibility,
  pageLimit,
  pageOffset,
  requireUuid,
  requiredString,
} from "../http/body";
import type { OwnerRef } from "../modules/access";
import {
  addVisualizationReference,
  changeVisualizationStatus,
  createVisualization,
  listVisualizations,
  removeVisualizationReference,
  reorderVisualizationReferences,
  requireVisualization,
  updateVisualization,
  updateVisualizationReference,
  type VisualizationStatus,
} from "../modules/visualization";

export const visualizationsRouter = Router();

const blockedFields = ["url", "imageUrl", "href", "src", "provider", "generated", "storageKey"];

visualizationsRouter.post("/", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  rejectBlocked(body);
  const concept = await withTransaction((client) =>
    createVisualization(client, actorUserId, {
      owner: ownerFromBody(body, actorUserId),
      title: requiredString(body.title, "invalid_title", "Concept title is required."),
      notes: optionalString(body.notes),
      visibility: optionalVisibility(body.visibility),
      method: optionalString(body.method),
      designProjectId: optionalUuid(body.designProjectId, "not_found"),
      garmentId: optionalUuid(body.garmentId, "not_found"),
    }),
  );
  response.status(201).json({ concept });
});

visualizationsRouter.get("/", async (request, response) => {
  const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
  const limit = pageLimit(request.query.limit);
  const offset = pageOffset(request.query.offset);
  const page = await withTransaction((client) =>
    listVisualizations(client, actorUserId, {
      limit,
      offset,
      status: optionalStatus(request.query.status),
    }),
  );
  response.json({ concepts: page.concepts, page: { limit, offset, total: page.total } });
});

visualizationsRouter.post("/:id/generate", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body ?? {});
  rejectBlocked(body);
  const concept = await withTransaction((client) => requireVisualization(client, actorUserId, pathId(request.params.id)));
  if (concept.access === "view") throw invalid("forbidden", "You cannot change this visualization.");
  throw invalid("capability_unavailable", "Image generation is not configured.");
});

visualizationsRouter.post("/:id/status", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const concept = await withTransaction((client) =>
    changeVisualizationStatus(
      client,
      actorUserId,
      pathId(request.params.id),
      requiredString(body.status, "invalid_status", "Visualization status is required."),
    ),
  );
  response.json({ concept });
});

visualizationsRouter.post("/:id/references/order", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const concept = await withTransaction((client) =>
    reorderVisualizationReferences(client, actorUserId, pathId(request.params.id), uuidList(body.mediaIds)),
  );
  response.json({ concept });
});

visualizationsRouter.post("/:id/references", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  rejectBlocked(body);
  const concept = await withTransaction((client) =>
    addVisualizationReference(client, actorUserId, pathId(request.params.id), {
      mediaId: requireUuid(requiredString(body.mediaId, "invalid_body", "Media is required."), "not_found"),
      origin: requiredString(body.origin, "invalid_origin", "Reference origin is required."),
      note: optionalString(body.note),
    }),
  );
  response.status(201).json({ concept });
});

visualizationsRouter.patch("/:id/references/:mediaId", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const concept = await withTransaction((client) =>
    updateVisualizationReference(
      client,
      actorUserId,
      pathId(request.params.id),
      pathId(request.params.mediaId),
      requiredString(body.note, "invalid_note", "Reference note is required."),
    ),
  );
  response.json({ concept });
});

visualizationsRouter.delete("/:id/references/:mediaId", async (request, response) => {
  const actorUserId = requireUser(response);
  const concept = await withTransaction((client) =>
    removeVisualizationReference(client, actorUserId, pathId(request.params.id), pathId(request.params.mediaId)),
  );
  response.json({ concept });
});

visualizationsRouter.get("/:id", async (request, response) => {
  const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
  const concept = await withTransaction((client) => requireVisualization(client, actorUserId, pathId(request.params.id)));
  response.json({ concept });
});

visualizationsRouter.patch("/:id", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  rejectBlocked(body);
  if ("status" in body) throw invalid("invalid_status", "Change status with the status endpoint.");
  const concept = await withTransaction((client) =>
    updateVisualization(client, actorUserId, pathId(request.params.id), {
      title: optionalString(body.title),
      notes: optionalString(body.notes),
      visibility: optionalVisibility(body.visibility),
      method: optionalString(body.method),
      designProjectId: nullableUuid(body.designProjectId, "not_found"),
      revisionId: nullableUuid(body.revisionId, "not_found"),
      garmentId: nullableUuid(body.garmentId, "not_found"),
      previewMediaId: nullableUuid(body.previewMediaId, "not_found"),
    }),
  );
  response.json({ concept });
});

function rejectBlocked(body: Record<string, unknown>) {
  for (const key of blockedFields) {
    if (key in body) throw invalid("invalid_body", "That field is not accepted.");
  }
}

function optionalStatus(value: unknown): VisualizationStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "draft" || value === "arranged" || value === "archived") return value;
  throw invalid("invalid_status", "Visualization status is not recognized.");
}

function optionalUuid(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(code, "Not found.");
  return requireUuid(value, code);
}

function nullableUuid(value: unknown, code: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid(code, "Not found.");
  return requireUuid(value, code);
}

function uuidList(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid("invalid_order", "Provide each reference once.");
  return value.map((item) => {
    if (typeof item !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)) {
      throw invalid("invalid_order", "Provide each reference once.");
    }
    return item;
  });
}

function ownerFromBody(body: Record<string, unknown>, actorUserId: string): OwnerRef {
  if (body.organizationId === undefined) return { userId: actorUserId };
  if (typeof body.organizationId !== "string") throw invalid("invalid_owner", "Organization was not found.");
  return { organizationId: requireUuid(body.organizationId, "invalid_owner") };
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}
