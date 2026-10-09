import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, optionalString, requireUuid, requiredString } from "../http/body";
import {
  cancelOrder,
  changeOrderStatus,
  issueQuotation,
  listBusinessOrders,
  listCustomerOrders,
  readOrderMedia,
  requireOrder,
  respondToQuotation,
  submitOrder,
} from "../modules/orders";
import type { MediaStorage } from "../modules/storage";

const blocked = ["status", "currency", "amountMinor", "organizationId", "paid", "payment", "price", "verified"];
const moneyBlocked = ["paid", "payment", "price", "verified"];

export function ordersRouter(storage: MediaStorage) {
  const router = Router();

  router.get("/", async (request, response) => {
    const actorUserId = requireUser(response);
    const organizationId = optionalUuid(request.query.organizationId);
    const orders = await withTransaction((client) =>
      organizationId ? listBusinessOrders(client, actorUserId, organizationId) : listCustomerOrders(client, actorUserId),
    );
    response.json({ orders });
  });

  router.post("/", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const result = await withTransaction((client) =>
      submitOrder(client, actorUserId, {
        listingId: requireUuid(requiredString(body.listingId, "not_found", "Listing was not found.")),
        quantity: quantityOf(body.quantity),
        customizationNote: optionalString(body.customizationNote) ?? "",
        measurementIds: uuidList(body.measurementIds),
        mediaIds: uuidList(body.mediaIds),
        idempotencyKey: idempotencyKey(request.header("idempotency-key")),
      }),
    );
    response.status(result.duplicate ? 200 : 201).json(result);
  });

  router.get("/:id/media/:mediaId/content", async (request, response) => {
    const actorUserId = requireUser(response);
    const file = await withTransaction((client) =>
      readOrderMedia(client, actorUserId, pathId(request.params.id), pathId(request.params.mediaId), storage),
    );
    response.setHeader("Content-Type", file.mimeType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Disposition", `inline; filename="${asciiFilename(file.filename)}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.send(file.bytes);
  });

  router.get("/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const order = await withTransaction((client) => requireOrder(client, actorUserId, pathId(request.params.id)));
    response.json({ order });
  });

  router.post("/:id/cancel", async (request, response) => {
    const actorUserId = requireUser(response);
    const order = await withTransaction((client) => cancelOrder(client, actorUserId, pathId(request.params.id)));
    response.json({ order });
  });

  router.post("/:id/status", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectFields(body, moneyBlocked);
    const order = await withTransaction((client) =>
      changeOrderStatus(
        client,
        actorUserId,
        pathId(request.params.id),
        requiredString(body.status, "invalid_transition", "That order status change is not available."),
      ),
    );
    response.json({ order });
  });

  router.post("/:id/quotations", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectFields(body, moneyBlocked);
    const order = await withTransaction((client) =>
      issueQuotation(client, actorUserId, pathId(request.params.id), {
        currency: requiredString(body.currency, "invalid_currency", "Use a three-letter currency code."),
        amountMinor: minor(body.amountMinor),
        note: optionalString(body.note) ?? "",
        expiresAt: expiration(body.expiresAt),
      }),
    );
    response.status(201).json({ order });
  });

  router.post("/:id/quotations/:quoteId/accept", async (request, response) => {
    const actorUserId = requireUser(response);
    const order = await withTransaction((client) =>
      respondToQuotation(client, actorUserId, pathId(request.params.id), pathId(request.params.quoteId), "accepted"),
    );
    response.json({ order });
  });

  router.post("/:id/quotations/:quoteId/reject", async (request, response) => {
    const actorUserId = requireUser(response);
    const order = await withTransaction((client) =>
      respondToQuotation(client, actorUserId, pathId(request.params.id), pathId(request.params.quoteId), "rejected"),
    );
    response.json({ order });
  });

  return router;
}

function rejectBlocked(body: Record<string, unknown>) {
  rejectFields(body, blocked);
}

function rejectFields(body: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (key in body) throw invalid("unsupported_constraint", "That field is not accepted.");
  }
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function optionalUuid(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function quantityOf(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid("invalid_quantity", "Quantity must be a whole number from 1 to 20.");
  }
  return value;
}

function uuidList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("invalid_body", "Expected a list of identifiers.");
  return value.map((item) => {
    if (typeof item !== "string") throw invalid("not_found", "Not found.");
    return requireUuid(item);
  });
}

function minor(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid("invalid_price", "Enter a non-negative whole amount in minor currency units.");
  }
  return value;
}

function expiration(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalid("invalid_expiration", "Expiration must be a time.");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid("invalid_expiration", "Expiration must be a time.");
  return date;
}

function idempotencyKey(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw invalid("invalid_body", "Idempotency key is not valid.");
  return value;
}

function asciiFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._ -]/g, "") || "image";
  return cleaned.slice(0, 120);
}
