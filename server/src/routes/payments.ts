import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { createRateLimiter } from "../http/upload-limit";
import { requireUser } from "../http/actor";
import { objectBody, requireUuid, requiredString } from "../http/body";
import type { PaymentAdapter } from "../modules/payment-adapter";
import {
  cancelPayment,
  confirmSimulatedPayment,
  failSimulatedPayment,
  initiatePayment,
  listCustomerPayments,
  reconcilePayment,
  recoverPaymentInitiation,
  requirePayment,
} from "../modules/payments";

const blocked = [
  "amountMinor",
  "currency",
  "state",
  "status",
  "paid",
  "captured",
  "provider",
  "providerReference",
  "providerState",
  "verified",
  "realMoney",
  "simulated",
];

export function paymentsRouter(options: { adapter: PaymentAdapter; simulationEnabled: boolean; maxPerMinute: number }) {
  const router = Router();
  const limit = createRateLimiter(options.maxPerMinute, "Too many payment requests. Try again shortly.");

  router.get("/", async (request, response) => {
    const actorUserId = requireUser(response);
    const orderId = optionalUuid(request.query.orderId);
    const payments = await withTransaction((client) => listCustomerPayments(client, actorUserId, orderId));
    response.json({ payments });
  });

  router.post("/", async (request, response) => {
    const actorUserId = requireUser(response);
    limit(actorUserId);
    const body = objectBody(request.body);
    rejectFields(body);
    const orderId = requireUuid(requiredString(body.orderId, "not_found", "Order was not found."));
    const idempotencyKey = idempotencyHeader(request.header("idempotency-key"));
    const result = await runInit(actorUserId, orderId, idempotencyKey, options);
    response.status(result.duplicate ? 200 : 201).json(result);
  });

  router.get("/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const payment = await withTransaction((client) => requirePayment(client, actorUserId, pathId(request.params.id)));
    response.json({ payment });
  });

  router.post("/:id/cancel", async (request, response) => {
    const actorUserId = requireUser(response);
    rejectBody(request.body);
    const payment = await withTransaction((client) => cancelPayment(client, actorUserId, pathId(request.params.id)));
    response.json({ payment });
  });

  router.post("/:id/simulation/confirm", async (request, response) => {
    const actorUserId = requireUser(response);
    rejectBody(request.body);
    const result = await withTransaction((client) =>
      confirmSimulatedPayment(client, actorUserId, options.adapter, options.simulationEnabled, pathId(request.params.id)),
    );
    if (!result.ok) throw invalid(result.code, result.message);
    response.json({ payment: result.payment, duplicate: result.duplicate });
  });

  router.post("/:id/simulation/fail", async (request, response) => {
    const actorUserId = requireUser(response);
    rejectBody(request.body);
    const result = await withTransaction((client) =>
      failSimulatedPayment(client, actorUserId, options.adapter, options.simulationEnabled, pathId(request.params.id)),
    );
    if (!result.ok) throw invalid(result.code, result.message);
    response.json({ payment: result.payment, duplicate: result.duplicate });
  });

  router.post("/:id/reconciliation", async (request, response) => {
    const actorUserId = requireUser(response);
    rejectBody(request.body);
    const result = await withTransaction((client) =>
      reconcilePayment(client, actorUserId, pathId(request.params.id), null),
    );
    response.json(result);
  });

  return router;
}

async function runInit(
  actorUserId: string,
  orderId: string,
  idempotencyKey: string | null,
  options: { adapter: PaymentAdapter; simulationEnabled: boolean },
) {
  try {
    return await withTransaction((client) =>
      initiatePayment(client, actorUserId, options.adapter, options.simulationEnabled, { orderId, idempotencyKey }),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return withTransaction((client) => recoverPaymentInitiation(client, actorUserId, orderId, idempotencyKey));
  }
}

function rejectBody(value: unknown) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return;
  const body = objectBody(value);
  rejectFields(body);
}

function rejectFields(body: Record<string, unknown>) {
  for (const key of blocked) {
    if (key in body) throw invalid("unsupported_constraint", "That field is not accepted.");
  }
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function idempotencyHeader(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) throw invalid("invalid_body", "Idempotency key is not valid.");
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505";
}
