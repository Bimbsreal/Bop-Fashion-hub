import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, pageLimit, pageOffset, requireUuid, requiredString } from "../http/body";
import { createFitAnalysis, fitRuleDescription, listFitAnalyses, requireFitAnalysis } from "../modules/fit-analysis";
import type { FitSize } from "../modules/fit-rules";

const blockedFields = ["ease", "confidence", "fitScore", "url"];

export function fitRouter() {
  const router = Router();

  router.get("/rules", (_request, response) => {
    requireUser(response);
    response.json({ rules: fitRuleDescription() });
  });

  router.post("/analyses", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    if ("fitPreference" in body) {
      throw invalid("unsupported_preference", "No fit preference allowance is configured.");
    }
    const analysis = await withTransaction((client) =>
      createFitAnalysis(client, actorUserId, {
        profileId: requireUuid(requiredString(body.profileId, "not_found", "Measurement profile was not found.")),
        garmentId: requireUuid(requiredString(body.garmentId, "not_found", "Garment was not found.")),
        size: sizeOf(body.size),
      }),
    );
    response.status(201).json({ analysis });
  });

  router.get("/analyses", async (request, response) => {
    const actorUserId = requireUser(response);
    const limit = pageLimit(request.query.limit);
    const offset = pageOffset(request.query.offset);
    const profileId = typeof request.query.profileId === "string" ? requireUuid(request.query.profileId) : undefined;
    const page = await withTransaction((client) => listFitAnalyses(client, actorUserId, { limit, offset, profileId }));
    response.json({ analyses: page.analyses, page: { limit, offset, total: page.total } });
  });

  router.get("/analyses/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const analysis = await withTransaction((client) => requireFitAnalysis(client, actorUserId, pathId(request.params.id)));
    response.json({ analysis });
  });

  return router;
}

function sizeOf(value: unknown): FitSize | null {
  if (value === undefined || value === null) return null;
  const record = objectBody(value);
  return {
    system: requiredString(record.system, "unknown_size", "Size label was not found.").trim().toLowerCase(),
    label: requiredString(record.label, "unknown_size", "Size label was not found.").trim(),
  };
}

function rejectBlocked(body: Record<string, unknown>) {
  for (const key of blockedFields) {
    if (key in body) throw invalid("invalid_body", "That field is not accepted.");
  }
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}
