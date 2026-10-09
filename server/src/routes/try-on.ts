import { Router } from "express";
import { readConfig } from "../config";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, pageLimit, pageOffset, requireUuid, requiredString } from "../http/body";
import { createRateLimiter } from "../http/upload-limit";
import type { OwnerRef } from "../modules/access";
import {
  cancelTryOnRequest,
  createTryOnRequest,
  listTryOnRequests,
  requireTryOnRequest,
  tryOnCapability,
  type TryOnLimits,
} from "../modules/try-on";

const blockedFields = ["url", "imageUrl", "href", "src", "provider", "generated", "storageKey"];
const minEdge = 256;

export function tryOnRouter() {
  const router = Router();
  const config = readConfig();
  const limits: TryOnLimits = { maxBytes: config.maxMediaBytes, maxEdge: config.maxMediaEdge, minEdge };
  const limitRequests = createRateLimiter(config.aiMaxTasksPerMinute, "Too many try-on requests. Try again shortly.");

  router.get("/capability", (_request, response) => {
    response.json({ capability: tryOnCapability(limits) });
  });

  router.post("/", async (request, response) => {
    const actorUserId = requireUser(response);
    limitRequests(actorUserId);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const created = await withTransaction((client) =>
      createTryOnRequest(
        client,
        actorUserId,
        {
          owner: ownerFromBody(body, actorUserId),
          personMediaId: requireUuid(requiredString(body.personMediaId, "invalid_media", "A person image is required."), "not_found"),
          garmentId: requireUuid(requiredString(body.garmentId, "invalid_garment", "A garment is required."), "not_found"),
          garmentMediaId: requireUuid(requiredString(body.garmentMediaId, "invalid_media", "A garment image is required."), "not_found"),
          garmentPresentation: requiredString(body.garmentPresentation, "invalid_presentation", "Garment presentation is required."),
          designProjectId: optionalUuid(body.designProjectId),
          revisionId: optionalUuid(body.revisionId),
          visualizationId: optionalUuid(body.visualizationId),
          consentPurpose: consentPurpose(body.consent),
          idempotencyKey: idempotencyHeader(request.header("idempotency-key")),
        },
        limits,
      ),
    );
    response.status(created.replayed ? 200 : 201).json({ request: created.request });
  });

  router.get("/", async (request, response) => {
    const actorUserId = requireUser(response);
    const limit = pageLimit(request.query.limit);
    const offset = pageOffset(request.query.offset);
    const page = await withTransaction((client) => listTryOnRequests(client, actorUserId, { limit, offset }));
    response.json({ requests: page.requests, page: { limit, offset, total: page.total } });
  });

  router.post("/:id/cancel", async (request, response) => {
    const actorUserId = requireUser(response);
    const requestView = await withTransaction((client) =>
      cancelTryOnRequest(client, actorUserId, pathId(request.params.id)),
    );
    response.json({ request: requestView });
  });

  router.post("/:id/save", async (request, response) => {
    const actorUserId = requireUser(response);
    objectBody(request.body ?? {});
    await withTransaction((client) => requireTryOnRequest(client, actorUserId, pathId(request.params.id)));
    throw invalid("invalid_result", "No try-on result exists to save.");
  });

  router.get("/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const requestView = await withTransaction((client) =>
      requireTryOnRequest(client, actorUserId, pathId(request.params.id)),
    );
    response.json({ request: requestView });
  });

  return router;
}

function consentPurpose(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const record = objectBody(value);
  if (record.purpose !== "try_on_request") {
    throw invalid("consent_required", "Confirm this image may be used for this try-on request only.");
  }
  if ("training" in record) throw invalid("consent_required", "This confirmation does not allow model training.");
  return "try_on_request";
}

function rejectBlocked(body: Record<string, unknown>) {
  for (const key of blockedFields) {
    if (key in body) throw invalid("invalid_body", "That field is not accepted.");
  }
}

function optionalUuid(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
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

function idempotencyHeader(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const key = value.trim();
  if (key.length < 8 || key.length > 80) throw invalid("invalid_body", "Idempotency key is not valid.");
  return key;
}
