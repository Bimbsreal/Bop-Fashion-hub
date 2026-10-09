import express, { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { optionalString, optionalVisibility, pageLimit, pageOffset, requireUuid } from "../http/body";
import { createUploadLimiter } from "../http/upload-limit";
import type { OwnerRef } from "../modules/access";
import type { ImageLimits } from "../modules/uploads";
import { deleteMedia, listMedia, readMediaContent, requireMedia, uploadImage } from "../modules/uploads";
import type { MediaStorage } from "../modules/storage";

export type MediaRouteOptions = {
  storage: MediaStorage;
  limits: ImageLimits;
  maxUploadsPerMinute: number;
};

export function mediaRouter(options: MediaRouteOptions) {
  const router = Router();
  const limitUploads = createUploadLimiter(options.maxUploadsPerMinute);

  router.post(
    "/",
    express.raw({ type: () => true, limit: options.limits.maxBytes }),
    async (request, response) => {
      const actorUserId = requireUser(response);
      limitUploads(actorUserId);
      if (!Buffer.isBuffer(request.body)) throw invalid("invalid_image", "Image could not be read.");
      const visibility = optionalVisibility(request.query.visibility) ?? "private";
      const filename = optionalString(request.header("x-original-filename"));
      const garmentId = optionalUuid(request.query.garmentId, "not_found");
      const organizationId = optionalUuid(request.query.organizationId, "invalid_owner");
      const role = optionalString(queryValue(request.query.role));
      const owner: OwnerRef = organizationId ? { organizationId } : { userId: actorUserId };
      const written: string[] = [];
      try {
        const media = await withTransaction((client) =>
          uploadImage(
            client,
            actorUserId,
            { bytes: request.body as Buffer, filename, visibility, owner, garmentId, role },
            options.storage,
            options.limits,
            (key) => written.push(key),
          ),
        );
        response.status(201).json({ media });
      } catch (error) {
        await Promise.all(written.map((key) => options.storage.remove(key).catch(() => undefined)));
        throw error;
      }
    },
  );

  router.get("/", async (request, response) => {
    const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
    const limit = pageLimit(request.query.limit);
    const offset = pageOffset(request.query.offset);
    const page = await withTransaction((client) => listMedia(client, actorUserId, { limit, offset }));
    response.json({ media: page.media, page: { limit, offset, total: page.total } });
  });

  router.get("/:id/content", async (request, response) => {
    const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
    const file = await withTransaction((client) =>
      readMediaContent(client, actorUserId, pathId(request.params.id), options.storage),
    );
    response.setHeader("Content-Type", file.mimeType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Disposition", `inline; filename="${asciiFilename(file.filename)}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.send(file.bytes);
  });

  router.get("/:id", async (request, response) => {
    const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
    const media = await withTransaction((client) => requireMedia(client, actorUserId, pathId(request.params.id)));
    response.json({ media });
  });

  router.delete("/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    await withTransaction((client) => deleteMedia(client, actorUserId, pathId(request.params.id), options.storage));
    response.status(204).end();
  });

  return router;
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function optionalUuid(value: unknown, code: string): string | undefined {
  const text = queryValue(value);
  if (text === undefined) return undefined;
  return requireUuid(text, code);
}

function queryValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("invalid_body", "Expected a string.");
  return value;
}

function asciiFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._ -]/g, "") || "image";
  return cleaned.slice(0, 120);
}
