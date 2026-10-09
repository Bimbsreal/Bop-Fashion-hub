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
  changeDesignStatus,
  createDesignProject,
  createDesignRevision,
  deleteDesignProject,
  linkDesignGarment,
  linkDesignMedia,
  listDesignProjects,
  listDesignRevisions,
  requireProject,
  unlinkDesignGarment,
  unlinkDesignMedia,
  updateDesignProject,
  type ProjectStatus,
} from "../modules/design";

export const designRouter = Router();

designRouter.post("/", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  rejectStatusField(body);
  const project = await withTransaction((client) =>
    createDesignProject(client, actorUserId, {
      owner: ownerFromBody(body, actorUserId),
      name: requiredString(body.name, "invalid_name", "Project name is required."),
      description: optionalString(body.description),
      visibility: optionalVisibility(body.visibility),
    }),
  );
  response.status(201).json({ project });
});

designRouter.get("/", async (request, response) => {
  const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
  const limit = pageLimit(request.query.limit);
  const offset = pageOffset(request.query.offset);
  const page = await withTransaction((client) =>
    listDesignProjects(client, actorUserId, {
      limit,
      offset,
      status: optionalStatus(request.query.status),
    }),
  );
  response.json({ projects: page.projects, page: { limit, offset, total: page.total } });
});

designRouter.get("/:id/revisions", async (request, response) => {
  const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
  const limit = pageLimit(request.query.limit);
  const offset = pageOffset(request.query.offset);
  const page = await withTransaction((client) =>
    listDesignRevisions(client, actorUserId, pathId(request.params.id), { limit, offset }),
  );
  response.json({ revisions: page.revisions, page: { limit, offset, total: page.total } });
});

designRouter.post("/:id/revisions", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const revision = await withTransaction((client) =>
    createDesignRevision(client, actorUserId, pathId(request.params.id), optionalString(body.note)),
  );
  response.status(201).json({ revision });
});

designRouter.post("/:id/garments", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const project = await withTransaction((client) =>
    linkDesignGarment(client, actorUserId, pathId(request.params.id), {
      garmentId: requireUuid(requiredString(body.garmentId, "invalid_body", "Garment is required."), "not_found"),
      role: optionalString(body.role),
    }),
  );
  response.status(201).json({ project });
});

designRouter.delete("/:id/garments/:garmentId", async (request, response) => {
  const actorUserId = requireUser(response);
  const project = await withTransaction((client) =>
    unlinkDesignGarment(client, actorUserId, pathId(request.params.id), pathId(request.params.garmentId)),
  );
  response.json({ project });
});

designRouter.post("/:id/media", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const project = await withTransaction((client) =>
    linkDesignMedia(client, actorUserId, pathId(request.params.id), {
      mediaId: requireUuid(requiredString(body.mediaId, "invalid_body", "Media is required."), "not_found"),
      role: optionalString(body.role),
    }),
  );
  response.status(201).json({ project });
});

designRouter.delete("/:id/media/:mediaId", async (request, response) => {
  const actorUserId = requireUser(response);
  const project = await withTransaction((client) =>
    unlinkDesignMedia(client, actorUserId, pathId(request.params.id), pathId(request.params.mediaId)),
  );
  response.json({ project });
});

designRouter.post("/:id/status", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const project = await withTransaction((client) =>
    changeDesignStatus(
      client,
      actorUserId,
      pathId(request.params.id),
      requiredString(body.status, "invalid_status", "Project status is required."),
    ),
  );
  response.json({ project });
});

designRouter.get("/:id", async (request, response) => {
  const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
  const project = await withTransaction((client) => requireProject(client, actorUserId, pathId(request.params.id)));
  response.json({ project });
});

designRouter.patch("/:id", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  rejectStatusField(body);
  const project = await withTransaction((client) =>
    updateDesignProject(client, actorUserId, pathId(request.params.id), {
      name: optionalString(body.name),
      description: optionalString(body.description),
      visibility: optionalVisibility(body.visibility),
    }),
  );
  response.json({ project });
});

designRouter.delete("/:id", async (request, response) => {
  const actorUserId = requireUser(response);
  await withTransaction((client) => deleteDesignProject(client, actorUserId, pathId(request.params.id)));
  response.status(204).end();
});

function rejectStatusField(body: Record<string, unknown>) {
  if ("status" in body) throw invalid("invalid_status", "Change status with the status endpoint.");
}

function optionalStatus(value: unknown): ProjectStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "draft" || value === "in_progress" || value === "ready_for_review" || value === "archived") {
    return value;
  }
  throw invalid("invalid_status", "Project status is not recognized.");
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
