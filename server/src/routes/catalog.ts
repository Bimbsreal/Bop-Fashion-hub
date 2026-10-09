import { Router } from "express";
import { withTransaction } from "../db/pool";
import { requireUser } from "../http/actor";
import {
  objectBody,
  optionalSlug,
  optionalString,
  optionalVisibility,
  pageLimit,
  pageOffset,
  requireUuid,
  requiredString,
  sizeList,
  termList,
} from "../http/body";
import { invalid } from "../errors";
import { createCatalogGarment, getCatalogGarment, listCatalogGarments, updateCatalogGarment } from "../modules/fashion";
import { attachGarmentMedia } from "../modules/media";
import { recordGarmentMeasurement } from "../modules/measurements";
import type { OwnerRef } from "../modules/access";

export const catalogRouter = Router();

catalogRouter.post("/garments", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const garment = await withTransaction((client) =>
    createCatalogGarment(client, actorUserId, {
      owner: ownerFromBody(body, actorUserId),
      name: requiredString(body.name, "invalid_name", "Garment name is required."),
      description: optionalString(body.description),
      visibility: optionalVisibility(body.visibility),
      terms: termList(body.terms),
      sizeLabels: sizeList(body.sizeLabels),
    }),
  );
  response.status(201).json({ garment });
});

catalogRouter.get("/garments", async (request, response) => {
  const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
  const limit = pageLimit(request.query.limit);
  const offset = pageOffset(request.query.offset);
  const page = await withTransaction((client) =>
    listCatalogGarments(client, actorUserId, {
      limit,
      offset,
      type: optionalSlug(request.query.type),
      category: optionalSlug(request.query.category),
      material: optionalSlug(request.query.material),
      pattern: optionalSlug(request.query.pattern),
      style: optionalSlug(request.query.style),
      color: optionalSlug(request.query.color),
      visibility: optionalVisibility(request.query.visibility),
    }),
  );
  response.json({ garments: page.garments, page: { limit, offset, total: page.total } });
});

catalogRouter.get("/garments/:id", async (request, response) => {
  const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
  const garment = await withTransaction((client) =>
    getCatalogGarment(client, actorUserId, pathId(request.params.id)),
  );
  response.json({ garment });
});

catalogRouter.patch("/garments/:id", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const garment = await withTransaction((client) =>
    updateCatalogGarment(client, actorUserId, pathId(request.params.id), {
      name: optionalString(body.name),
      description: optionalString(body.description),
      visibility: optionalVisibility(body.visibility),
      terms: termList(body.terms),
      sizeLabels: sizeList(body.sizeLabels),
    }),
  );
  response.json({ garment });
});

catalogRouter.post("/garments/:id/media", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const garmentId = pathId(request.params.id);
  const garment = await withTransaction(async (client) => {
    await attachGarmentMedia(client, actorUserId, garmentId, {
      role: optionalString(body.role),
      mediaId: optionalString(body.mediaId),
      mediaType: optionalString(body.mediaType),
      mimeType: optionalString(body.mimeType),
      byteSize: optionalInteger(body.byteSize),
      storageKey: optionalString(body.storageKey),
      widthPx: optionalInteger(body.widthPx),
      heightPx: optionalInteger(body.heightPx),
    });
    return getCatalogGarment(client, actorUserId, garmentId);
  });
  response.status(201).json({ garment });
});

catalogRouter.post("/garments/:id/measurements", async (request, response) => {
  const actorUserId = requireUser(response);
  const body = objectBody(request.body);
  const garmentId = pathId(request.params.id);
  const size = body.size === undefined ? null : sizeList([body.size])?.[0];
  if (typeof body.definition !== "string" || typeof body.value !== "number") {
    throw invalid("invalid_measurement", "Measurement needs a definition and a value.");
  }
  if (body.unit !== undefined && typeof body.unit !== "string") {
    throw invalid("invalid_unit", "Use centimetres, metres, or inches.");
  }
  const definition = body.definition;
  const value = body.value;
  const unit = typeof body.unit === "string" ? body.unit : undefined;
  const garment = await withTransaction(async (client) => {
    await recordGarmentMeasurement(client, actorUserId, garmentId, { definition, value, size, unit });
    return getCatalogGarment(client, actorUserId, garmentId);
  });
  response.status(201).json({ garment });
});

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function ownerFromBody(body: Record<string, unknown>, actorUserId: string): OwnerRef {
  if (body.organizationId === undefined) return { userId: actorUserId };
  if (typeof body.organizationId !== "string") throw invalid("invalid_owner", "Organization was not found.");
  return { organizationId: requireUuid(body.organizationId, "invalid_owner") };
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid("invalid_body", "Expected a whole number.");
  }
  return value;
}
