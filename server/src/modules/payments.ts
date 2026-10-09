import type { PoolClient } from "pg";
import { activeMembership } from "./access";
import { forbidden, invalid, notFound } from "../errors";
import type { PaymentAdapter, ProviderFailureCategory } from "./payment-adapter";
import { currencyCode, minorExponent, wholeMinor } from "./payment-money";

const payableStatuses = new Set(["confirmed", "in_production", "ready_for_fulfillment", "completed"]);
const terminalOpen = new Set(["pending", "requires_action", "authorized", "captured"]);

const transitions: Record<string, string[]> = {
  pending: ["captured", "failed", "cancelled"],
  requires_action: [],
  authorized: [],
  captured: [],
  failed: [],
  cancelled: [],
  partially_refunded: [],
  refunded: [],
};

type IntentRow = {
  id: string;
  order_id: string;
  customer_user_id: string;
  organization_id: string;
  purpose: string;
  amount_minor: number;
  currency: string;
  minor_exponent: number | null;
  state: string;
  provider_id: string;
  simulated: boolean;
  real_money: boolean;
  expires_at: Date | null;
  created_at: Date;
  idempotency_key: string | null;
  order_status: string;
};

type AttemptRow = { attempt_number: number; outcome: string; failure_category: string | null };
type LedgerRow = {
  kind: string;
  amount_minor: number;
  currency: string;
  confirmation: string;
  simulated: boolean;
  real_money: boolean;
};

export type PaymentView = {
  id: string;
  orderId: string;
  purpose: string;
  amountMinor: number;
  currency: string;
  minorExponent: number | null;
  state: string;
  providerId: string;
  simulated: true;
  realMoney: false;
  externallyConfirmed: false;
  expiresAt: string | null;
  createdAt: string;
  attempts: { attemptNumber: number; outcome: string; failureCategory: string | null }[];
  ledger: {
    kind: string;
    amountMinor: number;
    currency: string;
    confirmation: string;
    simulated: true;
    realMoney: false;
  }[];
};

export function paymentTransitionAllowed(from: string, to: string): boolean {
  return (transitions[from] ?? []).includes(to);
}

export async function initiatePayment(
  client: PoolClient,
  actorUserId: string,
  adapter: PaymentAdapter,
  simulationEnabled: boolean,
  input: { orderId: string; idempotencyKey: string | null },
) {
  assertSimulation(simulationEnabled);
  const order = await lockOrder(client, input.orderId);
  await assertCustomer(client, actorUserId, order.customer_user_id, order.organization_id);
  assertPayable(order);
  const byKey = await findByKey(client, actorUserId, input.idempotencyKey);
  if (byKey) {
    if (byKey.order_id !== order.id) throw invalid("conflict", "That idempotency key was used for a different payment.");
    return { payment: await loadPayment(client, actorUserId, byKey.id), duplicate: true };
  }
  const existing = await findBlocking(client, order.id);
  if (existing) {
    if (input.idempotencyKey && existing.idempotency_key && existing.idempotency_key !== input.idempotencyKey) {
      throw invalid("conflict", "This order already has a payment record.");
    }
    return { payment: await loadPayment(client, actorUserId, existing.id), duplicate: true };
  }
  const started = await adapter.initialize();
  if (!started.ok) throw providerError(started.category);
  if (!currencyCode(order.currency) || !wholeMinor(order.agreed_amount_minor)) {
    throw invalid("invalid_price", "The order does not have a payable amount.");
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payment_intents (
       order_id, customer_user_id, organization_id, amount_minor, currency, minor_exponent, state,
       provider_id, provider_reference, idempotency_key, simulated, real_money, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,true,false, now() + interval '24 hours')
     RETURNING id`,
    [
      order.id,
      order.customer_user_id,
      order.organization_id,
      order.agreed_amount_minor,
      order.currency,
      minorExponent(order.currency),
      adapter.id,
      started.providerReference,
      input.idempotencyKey,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_body", "The payment could not be saved.");
  await insertAttempt(client, id, "created", null);
  return { payment: await loadPayment(client, actorUserId, id), duplicate: false };
}

export async function recoverPaymentInitiation(
  client: PoolClient,
  actorUserId: string,
  orderId: string,
  idempotencyKey: string | null,
) {
  const byKey = await findByKey(client, actorUserId, idempotencyKey);
  if (byKey) {
    if (byKey.order_id !== orderId) throw invalid("conflict", "That idempotency key was used for a different payment.");
    return { payment: await loadPayment(client, actorUserId, byKey.id), duplicate: true };
  }
  const existing = await findBlocking(client, orderId);
  if (!existing) throw invalid("conflict", "That payment was already recorded.");
  const payment = await loadPayment(client, actorUserId, existing.id);
  if (payment.orderId !== orderId) throw notFound("Payment was not found.");
  return { payment, duplicate: true };
}

export async function listCustomerPayments(client: PoolClient, actorUserId: string, orderId: string | null) {
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM payment_intents
     WHERE customer_user_id = $1 AND ($2::uuid IS NULL OR order_id = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [actorUserId, orderId],
  );
  const payments = [];
  for (const row of rows.rows) payments.push(await loadPayment(client, actorUserId, row.id));
  return payments;
}

export async function requirePayment(client: PoolClient, actorUserId: string, paymentId: string) {
  return loadPayment(client, actorUserId, paymentId);
}

export async function confirmSimulatedPayment(
  client: PoolClient,
  actorUserId: string,
  adapter: PaymentAdapter,
  simulationEnabled: boolean,
  paymentId: string,
) {
  assertSimulation(simulationEnabled);
  const current = await lockIntent(client, paymentId);
  await assertCustomer(client, actorUserId, current.customer_user_id, current.organization_id);
  if (current.state === "captured") {
    return { ok: true as const, payment: await loadPayment(client, actorUserId, current.id), duplicate: true };
  }
  if (current.state !== "pending") throw invalid("invalid_transition", "That payment change is not available.");
  if (current.expires_at && current.expires_at.getTime() <= Date.now()) {
    throw invalid("payment_expired", "This payment request has expired.");
  }
  const decision = await adapter.confirm(current.id);
  if (!decision.ok) {
    await insertAttempt(client, current.id, "failed", decision.category);
    return { ok: false as const, code: providerCode(decision.category), message: providerMessage(decision.category) };
  }
  return applyDevelopmentEvent(client, actorUserId, current, decision);
}

export async function failSimulatedPayment(
  client: PoolClient,
  actorUserId: string,
  adapter: PaymentAdapter,
  simulationEnabled: boolean,
  paymentId: string,
) {
  assertSimulation(simulationEnabled);
  const current = await lockIntent(client, paymentId);
  await assertCustomer(client, actorUserId, current.customer_user_id, current.organization_id);
  if (current.state !== "pending") throw invalid("invalid_transition", "That payment change is not available.");
  const decision = await adapter.fail(current.id);
  if (!decision.ok) {
    await insertAttempt(client, current.id, "failed", decision.category);
    return { ok: false as const, code: providerCode(decision.category), message: providerMessage(decision.category) };
  }
  return applyDevelopmentEvent(client, actorUserId, current, decision);
}

export async function cancelPayment(client: PoolClient, actorUserId: string, paymentId: string) {
  const current = await lockIntent(client, paymentId);
  await assertCustomer(client, actorUserId, current.customer_user_id, current.organization_id);
  move(current.state, "cancelled");
  await client.query(`UPDATE payment_intents SET state = 'cancelled', updated_at = now() WHERE id = $1`, [current.id]);
  await insertAttempt(client, current.id, "cancelled", null);
  return loadPayment(client, actorUserId, current.id);
}

export async function applyDevelopmentEvent(
  client: PoolClient,
  actorUserId: string,
  current: IntentRow,
  decision: { verified: boolean; reportedState: "captured" | "failed" | "pending"; eventId: string },
) {
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(decision.eventId)) {
    throw invalid("invalid_event", "The provider event is not valid.");
  }
  const prior = await client.query<{ id: string; processing: string }>(
    `SELECT id, processing FROM payment_provider_events WHERE provider_id = 'development' AND provider_event_id = $1`,
    [decision.eventId],
  );
  if (prior.rows[0]) {
    return { ok: true as const, payment: await loadPayment(client, actorUserId, current.id), duplicate: true };
  }
  if (!decision.verified) {
    await client.query(
      `INSERT INTO payment_provider_events (provider_id, provider_event_id, payment_intent_id, verified, processing, summary)
       VALUES ('development', $1, $2, false, 'rejected', 'unverified development event')`,
      [decision.eventId, current.id],
    );
    return { ok: false as const, code: "unverified_event", message: "The provider event was not verified." };
  }
  const next = decision.reportedState === "captured" ? "captured" : decision.reportedState === "failed" ? "failed" : null;
  if (!next || !paymentTransitionAllowed(current.state, next)) {
    await client.query(
      `INSERT INTO payment_provider_events (provider_id, provider_event_id, payment_intent_id, verified, processing, summary)
       VALUES ('development', $1, $2, true, 'ignored_stale', 'stale development event')`,
      [decision.eventId, current.id],
    );
    return { ok: true as const, payment: await loadPayment(client, actorUserId, current.id), duplicate: false };
  }
  const event = await client.query<{ id: string }>(
    `INSERT INTO payment_provider_events (provider_id, provider_event_id, payment_intent_id, verified, processing, summary)
     VALUES ('development', $1, $2, true, 'applied', 'development event applied')
     RETURNING id`,
    [decision.eventId, current.id],
  );
  const eventId = event.rows[0]?.id;
  await client.query(`UPDATE payment_intents SET state = $2, updated_at = now() WHERE id = $1`, [current.id, next]);
  const attemptId = await insertAttempt(
    client,
    current.id,
    next === "captured" ? "simulated_confirmed" : "failed",
    next === "failed" ? "permanent" : null,
  );
  if (next === "captured" && eventId) {
    await client.query(
      `INSERT INTO financial_transactions (
         payment_intent_id, payment_attempt_id, provider_event_id, order_id, kind, amount_minor, currency,
         confirmation, simulated, real_money
       ) VALUES ($1,$2,$3,$4,'simulated_capture',$5,$6,'simulated',true,false)`,
      [current.id, attemptId, eventId, current.order_id, current.amount_minor, current.currency],
    );
  }
  return { ok: true as const, payment: await loadPayment(client, actorUserId, current.id), duplicate: false };
}

export async function reconcilePayment(
  client: PoolClient,
  actorUserId: string,
  paymentId: string,
  injectedProviderState: string | null,
) {
  const current = await lockIntent(client, paymentId);
  const customer = current.customer_user_id === actorUserId;
  const membership = await activeMembership(client, actorUserId, current.organization_id);
  if (!customer && !membership) throw notFound("Payment was not found.");
  if (!customer && membership && membership.role !== "owner" && membership.role !== "admin") {
    throw forbidden("Only an owner or admin can reconcile for this business.");
  }
  const providerState = injectedProviderState ?? current.state;
  if (!knownProviderState(providerState)) throw invalid("invalid_event", "The provider state is not recognized.");
  const outcome = providerState !== current.state ? "mismatch" : current.state === "pending" ? "pending_review" : "matched_simulated";
  await client.query(
    `INSERT INTO payment_reconciliations (payment_intent_id, actor_user_id, internal_state, provider_state, outcome)
     VALUES ($1,$2,$3,$4,$5)`,
    [current.id, actorUserId, current.state, providerState, outcome],
  );
  const payment = await loadPayment(client, actorUserId, current.id);
  return { payment, reconciliation: { internalState: current.state, providerState, outcome } };
}

export async function loadIntentForEvent(client: PoolClient, paymentId: string): Promise<IntentRow> {
  return lockIntent(client, paymentId);
}

async function loadPayment(client: PoolClient, actorUserId: string, paymentId: string): Promise<PaymentView> {
  const current = await readIntent(client, paymentId);
  if (!current) throw notFound("Payment was not found.");
  const customer = current.customer_user_id === actorUserId;
  const membership = await activeMembership(client, actorUserId, current.organization_id);
  if (!customer && !membership) throw notFound("Payment was not found.");
  const attempts = await client.query<AttemptRow>(
    `SELECT attempt_number, outcome, failure_category FROM payment_attempts
     WHERE payment_intent_id = $1 ORDER BY attempt_number`,
    [paymentId],
  );
  const ledger = await client.query<LedgerRow>(
    `SELECT kind, amount_minor, currency, confirmation, simulated, real_money
     FROM financial_transactions WHERE payment_intent_id = $1 ORDER BY created_at, id`,
    [paymentId],
  );
  return {
    id: current.id,
    orderId: current.order_id,
    purpose: current.purpose,
    amountMinor: current.amount_minor,
    currency: current.currency,
    minorExponent: current.minor_exponent,
    state: current.state,
    providerId: current.provider_id,
    simulated: true,
    realMoney: false,
    externallyConfirmed: false,
    expiresAt: current.expires_at ? current.expires_at.toISOString() : null,
    createdAt: current.created_at.toISOString(),
    attempts: attempts.rows.map((row) => ({
      attemptNumber: row.attempt_number,
      outcome: row.outcome,
      failureCategory: row.failure_category,
    })),
    ledger: ledger.rows.map((row) => ({
      kind: row.kind,
      amountMinor: row.amount_minor,
      currency: row.currency,
      confirmation: row.confirmation,
      simulated: true,
      realMoney: false,
    })),
  };
}

async function lockOrder(client: PoolClient, orderId: string) {
  const result = await client.query<{
    id: string;
    customer_user_id: string;
    organization_id: string;
    status: string;
    agreed_amount_minor: number | null;
    currency: string | null;
  }>(
    `SELECT id, customer_user_id, organization_id, status, agreed_amount_minor, currency
     FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const order = result.rows[0];
  if (!order) throw notFound("Order was not found.");
  return order as {
    id: string;
    customer_user_id: string;
    organization_id: string;
    status: string;
    agreed_amount_minor: number;
    currency: string;
  };
}

async function lockIntent(client: PoolClient, paymentId: string): Promise<IntentRow> {
  const result = await client.query<IntentRow>(
    `SELECT intent.id, intent.order_id, intent.customer_user_id, intent.organization_id, intent.purpose,
            intent.amount_minor, intent.currency, intent.minor_exponent, intent.state, intent.provider_id,
            intent.simulated, intent.real_money, intent.expires_at, intent.created_at, intent.idempotency_key,
            orders.status AS order_status
     FROM payment_intents AS intent
     JOIN orders ON orders.id = intent.order_id
     WHERE intent.id = $1
     FOR UPDATE OF intent`,
    [paymentId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Payment was not found.");
  return row;
}

async function readIntent(client: PoolClient, paymentId: string): Promise<IntentRow | null> {
  const result = await client.query<IntentRow>(
    `SELECT intent.id, intent.order_id, intent.customer_user_id, intent.organization_id, intent.purpose,
            intent.amount_minor, intent.currency, intent.minor_exponent, intent.state, intent.provider_id,
            intent.simulated, intent.real_money, intent.expires_at, intent.created_at, intent.idempotency_key,
            orders.status AS order_status
     FROM payment_intents AS intent
     JOIN orders ON orders.id = intent.order_id
     WHERE intent.id = $1`,
    [paymentId],
  );
  return result.rows[0] ?? null;
}

async function findByKey(client: PoolClient, actorUserId: string, key: string | null) {
  if (!key) return null;
  const result = await client.query<{ id: string; order_id: string }>(
    `SELECT id, order_id FROM payment_intents WHERE customer_user_id = $1 AND idempotency_key = $2`,
    [actorUserId, key],
  );
  return result.rows[0] ?? null;
}

async function findBlocking(client: PoolClient, orderId: string) {
  const result = await client.query<{ id: string; idempotency_key: string | null }>(
    `SELECT id, idempotency_key FROM payment_intents
     WHERE order_id = $1 AND state = ANY($2::text[])
     ORDER BY created_at DESC
     LIMIT 1`,
    [orderId, [...terminalOpen]],
  );
  return result.rows[0] ?? null;
}

async function insertAttempt(
  client: PoolClient,
  paymentId: string,
  outcome: string,
  failure: ProviderFailureCategory | null,
) {
  const next = await client.query<{ attempt_number: number }>(
    `SELECT coalesce(max(attempt_number), 0) + 1 AS attempt_number FROM payment_attempts WHERE payment_intent_id = $1`,
    [paymentId],
  );
  const attemptNumber = next.rows[0]?.attempt_number ?? 1;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payment_attempts (payment_intent_id, attempt_number, outcome, failure_category)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [paymentId, attemptNumber, outcome, failure],
  );
  return inserted.rows[0]?.id ?? null;
}

async function assertCustomer(client: PoolClient, actorUserId: string, customerUserId: string, organizationId: string) {
  if (actorUserId === customerUserId) return;
  const membership = await activeMembership(client, actorUserId, organizationId);
  if (membership) throw forbidden("Only the customer can change this payment.");
  throw notFound("Payment was not found.");
}

function assertPayable(order: { status: string; agreed_amount_minor: number | null; currency: string | null }) {
  if (!payableStatuses.has(order.status) || order.agreed_amount_minor === null || !order.currency || !currencyCode(order.currency)) {
    throw invalid("not_payable", "This order does not have an agreed amount that can be paid.");
  }
}

function assertSimulation(enabled: boolean) {
  if (!enabled) throw invalid("simulation_disabled", "Payment simulation is not enabled.");
}

function move(from: string, to: string) {
  if (!paymentTransitionAllowed(from, to)) throw invalid("invalid_transition", "That payment change is not available.");
}

function knownProviderState(value: string): boolean {
  return (
    value === "unknown" ||
    value === "pending" ||
    value === "requires_action" ||
    value === "authorized" ||
    value === "captured" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "partially_refunded" ||
    value === "refunded"
  );
}

function providerError(category: ProviderFailureCategory): Error {
  return invalid(providerCode(category), providerMessage(category));
}

function providerCode(category: ProviderFailureCategory): string {
  if (category === "timeout") return "provider_timeout";
  if (category === "retryable" || category === "unavailable") return "provider_unavailable";
  return "provider_rejected";
}

function providerMessage(category: ProviderFailureCategory): string {
  if (category === "timeout" || category === "retryable" || category === "unavailable") {
    return "The payment provider did not respond. No payment was recorded.";
  }
  return "The payment provider rejected the request. No payment was recorded.";
}
