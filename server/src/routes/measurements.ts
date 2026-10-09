import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, pageLimit, pageOffset, requireUuid, requiredString } from "../http/body";
import {
  archiveBodyMeasurement,
  createMeasurementProfile,
  deleteMeasurementProfile,
  grantProfileAccess,
  listBodyDefinitions,
  listMeasurementHistory,
  listMeasurementProfiles,
  recordBodyMeasurement,
  requireProfile,
  revokeProfileAccess,
  updateMeasurementProfile,
  verifyBodyMeasurement,
} from "../modules/body-measurements";
import { isMeasureUnit, type MeasureUnit } from "../modules/measure-units";

const blockedFields = ["organizationId", "size", "sizeLabel", "ease", "confidence", "fit", "url", "imageUrl"];

export function measurementsRouter() {
  const router = Router();

  router.get("/definitions", async (_request, response) => {
    requireUser(response);
    const described = await withTransaction((client) => listBodyDefinitions(client));
    response.json(described);
  });

  router.get("/profiles", async (request, response) => {
    const actorUserId = requireUser(response);
    const status = request.query.status === "archived" ? "archived" : "active";
    if (request.query.status !== undefined && request.query.status !== "active" && request.query.status !== "archived") {
      throw invalid("invalid_body", "Profile status must be active or archived.");
    }
    const page = await withTransaction((client) =>
      listMeasurementProfiles(client, actorUserId, {
        limit: pageLimit(request.query.limit),
        offset: pageOffset(request.query.offset),
        status,
      }),
    );
    response.json({
      profiles: page.profiles,
      page: { limit: pageLimit(request.query.limit), offset: pageOffset(request.query.offset), total: page.total },
    });
  });

  router.post("/profiles", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const created = await withTransaction((client) =>
      createMeasurementProfile(client, actorUserId, {
        name: requiredString(body.name, "invalid_name", "Enter a profile name."),
        notes: notesOf(body.notes),
        preferredUnit: unitOf(body.preferredUnit, true),
      }),
    );
    response.status(201).json({ profile: created });
  });

  router.get("/profiles/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const profile = await withTransaction((client) => requireProfile(client, actorUserId, pathId(request.params.id)));
    response.json({ profile });
  });

  router.patch("/profiles/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const profile = await withTransaction((client) =>
      updateMeasurementProfile(client, actorUserId, pathId(request.params.id), {
        name: typeof body.name === "string" ? body.name : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        preferredUnit: body.preferredUnit === undefined ? undefined : unitOf(body.preferredUnit, false),
        status: statusOf(body.status),
      }),
    );
    response.json({ profile });
  });

  router.delete("/profiles/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    await withTransaction((client) => deleteMeasurementProfile(client, actorUserId, pathId(request.params.id)));
    response.status(204).end();
  });

  router.post("/profiles/:id/measurements", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const value = body.value;
    if (typeof value !== "string") {
      throw invalid("invalid_measurement", "Enter the measurement as a decimal number.");
    }
    const measurement = await withTransaction((client) =>
      recordBodyMeasurement(client, actorUserId, pathId(request.params.id), {
        definition: requiredString(body.definition, "unknown_measurement", "That body measurement was not found."),
        value,
        unit: requiredString(body.unit, "invalid_unit", "Use centimetres, metres, or inches."),
        source: requiredString(body.source, "invalid_source", "That measurement source is not recognized."),
        note: typeof body.note === "string" ? body.note : "",
      }),
    );
    response.status(201).json({ measurement });
  });

  router.get("/profiles/:id/history", async (request, response) => {
    const actorUserId = requireUser(response);
    const definition = typeof request.query.definition === "string" ? request.query.definition : null;
    const measurements = await withTransaction((client) =>
      listMeasurementHistory(client, actorUserId, pathId(request.params.id), definition),
    );
    response.json({ measurements });
  });

  router.post("/profiles/:id/measurements/:measurementId/archive", async (request, response) => {
    const actorUserId = requireUser(response);
    const measurement = await withTransaction((client) =>
      archiveBodyMeasurement(client, actorUserId, pathId(request.params.id), pathId(request.params.measurementId)),
    );
    response.json({ measurement });
  });

  router.post("/profiles/:id/measurements/:measurementId/verify", async (request, response) => {
    const actorUserId = requireUser(response);
    const measurement = await withTransaction((client) =>
      verifyBodyMeasurement(client, actorUserId, pathId(request.params.id), pathId(request.params.measurementId)),
    );
    response.json({ measurement });
  });

  router.post("/profiles/:id/grants", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const grant = await withTransaction((client) =>
      grantProfileAccess(client, actorUserId, pathId(request.params.id), {
        email: requiredString(body.email, "invalid_grant", "Enter the person's email address."),
        permission: requiredString(body.permission, "invalid_permission", "Choose read, record, or verify access."),
      }),
    );
    response.status(grant.created ? 201 : 200).json({ grant });
  });

  router.delete("/profiles/:id/grants/:userId", async (request, response) => {
    const actorUserId = requireUser(response);
    await withTransaction((client) =>
      revokeProfileAccess(client, actorUserId, pathId(request.params.id), pathId(request.params.userId)),
    );
    response.status(204).end();
  });

  return router;
}

function notesOf(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw invalid("invalid_notes", "Notes must be text.");
  return value;
}

function unitOf(value: unknown, allowMissing: boolean): MeasureUnit {
  if (value === undefined && allowMissing) return "cm";
  if (typeof value !== "string" || !isMeasureUnit(value)) {
    throw invalid("invalid_unit", "Use centimetres, metres, or inches.");
  }
  return value;
}

function statusOf(value: unknown): "active" | "archived" | undefined {
  if (value === undefined) return undefined;
  if (value !== "active" && value !== "archived") {
    throw invalid("invalid_body", "Profile status must be active or archived.");
  }
  return value;
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
