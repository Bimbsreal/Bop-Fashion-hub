import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate, withRollback } from "../src/db/migrate";
import { closePool, getPool, withTransaction } from "../src/db/pool";
import { addMember } from "../src/modules/organizations";
import type { PaymentAdapter } from "../src/modules/payment-adapter";
import { applyDevelopmentEvent, loadIntentForEvent, reconcilePayment } from "../src/modules/payments";

const password = "payment-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Payment = {
  id: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  minorExponent: number | null;
  state: string;
  simulated: boolean;
  realMoney: boolean;
  externallyConfirmed: boolean;
  providerId: string;
  ledger: { kind: string; amountMinor: number; confirmation: string; realMoney: boolean }[];
  attempts: { outcome: string; failureCategory: string | null }[];
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so payment tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so payment tests were not executed.");
  await migrate(pool);
  await removePaymentFixtures(pool);
  server = createApp({ paymentSimulation: true, nodeEnv: "test" }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removePaymentFixtures(pool);
  await closePool();
});

test("a confirmed order copies its agreed amount into a simulated payment", async () => {
  assert.ok(pool);
  const seller = await register("Seller");
  const buyer = await register("Buyer");
  const stranger = await register("Stranger");
  const member = await register("Member");
  const businessId = await business(seller.cookie, "Pay Atelier");
  await withTransaction((client) => addMember(client, seller.id, { organizationId: businessId, userId: member.id, role: "member" }));
  const garmentId = await garment(seller.cookie, businessId);
  const listingId = await publishFixed(seller.cookie, businessId, garmentId, 2500);
  const created = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId, quantity: 2 } });
  assert.equal(created.status, 201);
  const orderId = (created.body as { order: { id: string; paid: boolean } }).order.id;
  assert.equal((created.body as { order: { paid: boolean } }).order.paid, false);
  const early = await request("POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(early.status, 400);
  assert.equal((early.body as { error: { code: string } }).error.code, "not_payable");
  const priced = await request("POST", "/api/v1/payments", {
    cookie: buyer.cookie,
    body: { orderId, amountMinor: 1, currency: "USD", state: "captured" },
  });
  assert.equal(priced.status, 400);
  await request("PATCH", `/api/v1/commerce/listings/${listingId}`, {
    cookie: seller.cookie,
    body: {
      offering: "ready_to_wear",
      title: "Indigo shirt",
      garmentId,
      pricingMethod: "fixed",
      currency: "NGN",
      amountMinor: 9000,
      availability: "available",
    },
  });
  await request("POST", `/api/v1/orders/${orderId}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  const anonymous = await request("POST", "/api/v1/payments", { body: { orderId } });
  assert.equal(anonymous.status, 401);
  const sellerPay = await request("POST", "/api/v1/payments", { cookie: seller.cookie, body: { orderId } });
  assert.equal(sellerPay.status, 403);
  const started = await request("POST", "/api/v1/payments", {
    cookie: buyer.cookie,
    body: { orderId },
    headers: { "idempotency-key": "shirt-pay-01" },
  });
  assert.equal(started.status, 201);
  const payment = (started.body as { payment: Payment }).payment;
  assert.equal(payment.amountMinor, 5000);
  assert.equal(payment.currency, "NGN");
  assert.equal(payment.minorExponent, 2);
  assert.equal(payment.state, "pending");
  assert.equal(payment.simulated, true);
  assert.equal(payment.realMoney, false);
  assert.equal(payment.externallyConfirmed, false);
  assert.equal(payment.providerId, "development");
  assert.equal(payment.ledger.length, 0);
  assert.equal("providerReference" in payment, false);
  assert.equal(JSON.stringify(payment).includes("devref"), false);
  const ledgerCount = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM financial_transactions WHERE payment_intent_id = $1`,
    [payment.id],
  );
  assert.equal(ledgerCount.rows[0]?.total, 0);
  const replay = await request("POST", "/api/v1/payments", {
    cookie: buyer.cookie,
    body: { orderId },
    headers: { "idempotency-key": "shirt-pay-01" },
  });
  assert.equal(replay.status, 200);
  assert.equal((replay.body as { payment: Payment; duplicate: boolean }).duplicate, true);
  assert.equal((replay.body as { payment: Payment }).payment.id, payment.id);
  const otherKey = await request("POST", "/api/v1/payments", {
    cookie: buyer.cookie,
    body: { orderId },
    headers: { "idempotency-key": "shirt-pay-02" },
  });
  assert.equal(otherKey.status, 409);
  const hidden = await request("GET", `/api/v1/payments/${payment.id}`, { cookie: stranger.cookie });
  assert.equal(hidden.status, 404);
  const sellerView = await request("GET", `/api/v1/payments/${payment.id}`, { cookie: seller.cookie });
  assert.equal(sellerView.status, 200);
  assert.equal((sellerView.body as { payment: Payment }).payment.realMoney, false);
  const memberPay = await request("POST", "/api/v1/payments", { cookie: member.cookie, body: { orderId } });
  assert.equal(memberPay.status, 403);
  const events = await request("POST", "/api/v1/payments/events", { cookie: buyer.cookie, body: { state: "captured" } });
  assert.equal(events.status, 404);
  const refunds = await request("POST", `/api/v1/payments/${payment.id}/refunds`, { cookie: buyer.cookie, body: {} });
  assert.equal(refunds.status, 404);
  const pendingReview = await request("POST", `/api/v1/payments/${payment.id}/reconciliation`, { cookie: buyer.cookie, body: {} });
  assert.equal(pendingReview.status, 200);
  assert.equal((pendingReview.body as { reconciliation: { outcome: string } }).reconciliation.outcome, "pending_review");
  const memberReview = await request("POST", `/api/v1/payments/${payment.id}/reconciliation`, { cookie: member.cookie, body: {} });
  assert.equal(memberReview.status, 403);
  const mismatch = await withTransaction((client) => reconcilePayment(client, buyer.id, payment.id, "captured"));
  assert.equal(mismatch.reconciliation.outcome, "mismatch");
  assert.equal(mismatch.payment.state, "pending");
  const confirmed = await request("POST", `/api/v1/payments/${payment.id}/simulation/confirm`, {
    cookie: buyer.cookie,
    body: { state: "captured", verified: true },
  });
  assert.equal(confirmed.status, 400);
  const recorded = await request("POST", `/api/v1/payments/${payment.id}/simulation/confirm`, { cookie: buyer.cookie });
  assert.equal(recorded.status, 200);
  const captured = (recorded.body as { payment: Payment }).payment;
  assert.equal(captured.state, "captured");
  assert.equal(captured.realMoney, false);
  assert.equal(captured.externallyConfirmed, false);
  assert.equal(captured.ledger.length, 1);
  assert.equal(captured.ledger[0]?.kind, "simulated_capture");
  assert.equal(captured.ledger[0]?.amountMinor, 5000);
  assert.equal(captured.ledger[0]?.confirmation, "simulated");
  assert.equal(captured.ledger[0]?.realMoney, false);
  const again = await request("POST", `/api/v1/payments/${payment.id}/simulation/confirm`, { cookie: buyer.cookie });
  assert.equal(again.status, 200);
  assert.equal((again.body as { duplicate: boolean }).duplicate, true);
  const rows = await pool.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM financial_transactions WHERE payment_intent_id = $1`,
    [payment.id],
  );
  assert.equal(rows.rows[0]?.total, 1);
  const order = await request("GET", `/api/v1/orders/${orderId}`, { cookie: buyer.cookie });
  assert.equal((order.body as { order: { paid: boolean; status: string } }).order.paid, false);
  assert.equal((order.body as { order: { status: string } }).order.status, "confirmed");
  await withTransaction(async (client) => {
    const intent = await loadIntentForEvent(client, payment.id);
    const stale = await applyDevelopmentEvent(client, buyer.id, intent, {
      verified: true,
      reportedState: "failed",
      eventId: `dev.stale.${payment.id}`,
    });
    assert.equal(stale.ok, true);
    if (stale.ok) assert.equal(stale.payment.state, "captured");
  });
  const still = await pool.query<{ state: string }>(`SELECT state FROM payment_intents WHERE id = $1`, [payment.id]);
  assert.equal(still.rows[0]?.state, "captured");
  const matched = await request("POST", `/api/v1/payments/${payment.id}/reconciliation`, { cookie: seller.cookie });
  assert.equal(matched.status, 200);
  assert.equal((matched.body as { reconciliation: { outcome: string } }).reconciliation.outcome, "matched_simulated");
  await assert.rejects(() =>
    withRollback(pool as Pool, (client) => client.query(`UPDATE payment_intents SET real_money = true WHERE id = $1`, [payment.id])),
  );
  const real = await pool.query<{ real_money: boolean }>(`SELECT real_money FROM payment_intents WHERE id = $1`, [payment.id]);
  assert.equal(real.rows[0]?.real_money, false);
});

test("an unapproved quotation and an unverified event cannot capture money", async () => {
  assert.ok(pool);
  const seller = await register("Tailor");
  const buyer = await register("Client");
  const businessId = await business(seller.cookie, "Quote Shop");
  const listing = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: seller.cookie,
    body: { offering: "custom_service", title: "Hem work", pricingMethod: "quote" },
  });
  const listingId = (listing.body as { listing: { id: string } }).listing.id;
  await request("POST", `/api/v1/commerce/listings/${listingId}/status`, { cookie: seller.cookie, body: { status: "published" } });
  const missing = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  assert.equal(missing.status, 400);
  const created = await request("POST", "/api/v1/orders", {
    cookie: buyer.cookie,
    body: { listingId, customizationNote: "Shorten the hem." },
  });
  const orderId = (created.body as { order: { id: string } }).order.id;
  const blocked = await request("POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(blocked.status, 400);
  const quoted = await request("POST", `/api/v1/orders/${orderId}/quotations`, {
    cookie: seller.cookie,
    body: { currency: "JPY", amountMinor: 1200 },
  });
  assert.equal(quoted.status, 201);
  const stillBlocked = await request("POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(stillBlocked.status, 400);
  const quoteId = (quoted.body as { order: { quotations: { id: string; status: string }[] } }).order.quotations.find(
    (item) => item.status === "issued",
  )?.id;
  await request("POST", `/api/v1/orders/${orderId}/quotations/${quoteId}/accept`, { cookie: buyer.cookie });
  const started = await request("POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(started.status, 201);
  const payment = (started.body as { payment: Payment }).payment;
  assert.equal(payment.amountMinor, 1200);
  assert.equal(payment.currency, "JPY");
  assert.equal(payment.minorExponent, 0);
  await withTransaction(async (client) => {
    const intent = await loadIntentForEvent(client, payment.id);
    const rejected = await applyDevelopmentEvent(client, buyer.id, intent, {
      verified: false,
      reportedState: "captured",
      eventId: `dev.bad.${payment.id}`,
    });
    assert.equal(rejected.ok, false);
  });
  const open = await request("GET", `/api/v1/payments/${payment.id}`, { cookie: buyer.cookie });
  assert.equal((open.body as { payment: Payment }).payment.state, "pending");
  assert.equal((open.body as { payment: Payment }).payment.ledger.length, 0);
  const processing = await pool.query<{ processing: string }>(
    `SELECT processing FROM payment_provider_events WHERE provider_event_id = $1`,
    [`dev.bad.${payment.id}`],
  );
  assert.equal(processing.rows[0]?.processing, "rejected");
  await pool.query(`UPDATE payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1`, [payment.id]);
  const expired = await request("POST", `/api/v1/payments/${payment.id}/simulation/confirm`, { cookie: buyer.cookie });
  assert.equal(expired.status, 400);
  assert.equal((expired.body as { error: { code: string } }).error.code, "payment_expired");
});

test("provider failures and production mode do not record a capture", async () => {
  assert.ok(pool);
  const seller = await register("Maker");
  const buyer = await register("Payer");
  const businessId = await business(seller.cookie, "Fail Shop");
  const garmentId = await garment(seller.cookie, businessId);
  const listingId = await publishFixed(seller.cookie, businessId, garmentId, 80);
  const created = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  const orderId = (created.body as { order: { id: string } }).order.id;
  await request("POST", `/api/v1/orders/${orderId}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  const timeoutUrl = await listenApp(createApp({ paymentSimulation: true, nodeEnv: "test", paymentAdapter: failingAdapter("timeout") }));
  const timedOut = await requestOn(timeoutUrl.base, "POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(timedOut.status, 503);
  assert.equal((timedOut.body as { error: { code: string } }).error.code, "provider_timeout");
  await timeoutUrl.close();
  const invalidUrl = await listenApp(
    createApp({ paymentSimulation: true, nodeEnv: "test", paymentAdapter: failingAdapter("invalid_response") }),
  );
  const rejected = await requestOn(invalidUrl.base, "POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(rejected.status, 400);
  assert.equal((rejected.body as { error: { code: string } }).error.code, "provider_rejected");
  await invalidUrl.close();
  const count = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM payment_intents WHERE order_id = $1`, [orderId]);
  assert.equal(count.rows[0]?.total, 0);
  const production = await listenApp(createApp({ paymentSimulation: true, nodeEnv: "production" }));
  const disabled = await requestOn(production.base, "POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(disabled.status, 400);
  assert.equal((disabled.body as { error: { code: string } }).error.code, "simulation_disabled");
  await production.close();
  const started = await request("POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId } });
  assert.equal(started.status, 201);
  const paymentId = (started.body as { payment: Payment }).payment.id;
  const failed = await request("POST", `/api/v1/payments/${paymentId}/simulation/fail`, { cookie: buyer.cookie });
  assert.equal(failed.status, 200);
  assert.equal((failed.body as { payment: Payment }).payment.state, "failed");
  assert.equal((failed.body as { payment: Payment }).payment.ledger.length, 0);
  const second = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  const secondId = (second.body as { order: { id: string } }).order.id;
  await request("POST", `/api/v1/orders/${secondId}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  const limited = await listenApp(createApp({ paymentSimulation: true, nodeEnv: "test", maxPaymentsPerMinute: 1 }));
  const first = await requestOn(limited.base, "POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId: secondId } });
  assert.equal(first.status, 201);
  const thirdOrder = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  const thirdId = (thirdOrder.body as { order: { id: string } }).order.id;
  await request("POST", `/api/v1/orders/${thirdId}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  const crowded = await requestOn(limited.base, "POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId: thirdId } });
  assert.equal(crowded.status, 429);
  await limited.close();
});

test("concurrent payment requests leave one intent", async () => {
  assert.ok(pool);
  const seller = await register("House");
  const buyer = await register("Guest");
  const businessId = await business(seller.cookie, "Race Shop");
  const garmentId = await garment(seller.cookie, businessId);
  const listingId = await publishFixed(seller.cookie, businessId, garmentId, 100);
  const created = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId, quantity: 1 } });
  const orderId = (created.body as { order: { id: string } }).order.id;
  await request("POST", `/api/v1/orders/${orderId}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  const [left, right] = await Promise.all([
    request("POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId }, headers: { "idempotency-key": "race-pay-01" } }),
    request("POST", "/api/v1/payments", { cookie: buyer.cookie, body: { orderId }, headers: { "idempotency-key": "race-pay-01" } }),
  ]);
  assert.equal([left.status, right.status].sort().join(","), "200,201");
  const leftId = (left.body as { payment: Payment }).payment.id;
  const rightId = (right.body as { payment: Payment }).payment.id;
  assert.equal(leftId, rightId);
  const count = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM payment_intents WHERE order_id = $1`, [orderId]);
  assert.equal(count.rows[0]?.total, 1);
  const another = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  const anotherId = (another.body as { order: { id: string } }).order.id;
  await request("POST", `/api/v1/orders/${anotherId}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  const clash = await request("POST", "/api/v1/payments", {
    cookie: buyer.cookie,
    body: { orderId: anotherId },
    headers: { "idempotency-key": "race-pay-01" },
  });
  assert.equal(clash.status, 409);
});

function failingAdapter(category: "timeout" | "invalid_response"): PaymentAdapter {
  return {
    id: "development",
    simulated: true,
    async initialize() {
      return { ok: false, category };
    },
    async confirm(intentId: string) {
      return { ok: true, verified: true, reportedState: "captured", eventId: `dev.confirm.${intentId}` };
    },
    async fail(intentId: string) {
      return { ok: true, verified: true, reportedState: "failed", eventId: `dev.fail.${intentId}` };
    },
  };
}

async function publishFixed(cookie: string, businessId: string, garmentId: string, amountMinor: number) {
  const draft = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie,
    body: {
      offering: "ready_to_wear",
      title: "Indigo shirt",
      garmentId,
      pricingMethod: "fixed",
      currency: "NGN",
      amountMinor,
      availability: "available",
    },
  });
  assert.equal(draft.status, 201);
  const listingId = (draft.body as { listing: { id: string } }).listing.id;
  const published = await request("POST", `/api/v1/commerce/listings/${listingId}/status`, { cookie, body: { status: "published" } });
  assert.equal(published.status, 200);
  return listingId;
}

async function business(cookie: string, name: string): Promise<string> {
  const response = await request("POST", "/api/v1/commerce/businesses", {
    cookie,
    body: { name, slug: `pay-${randomUUID().slice(0, 8)}`, kind: "tailor" },
  });
  assert.equal(response.status, 201);
  return (response.body as { business: { id: string } }).business.id;
}

async function garment(cookie: string, organizationId: string): Promise<string> {
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie,
    body: {
      organizationId,
      name: "Indigo shirt",
      visibility: "public",
      terms: [
        { kind: "garment_type", slug: "shirt" },
        { kind: "material", slug: "ankara" },
      ],
    },
  });
  assert.equal(created.status, 201);
  return (created.body as { garment: { id: string } }).garment.id;
}

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  const email = `${randomUUID()}@payment.test`;
  const response = await request("POST", "/api/v1/auth/register", { body: { email, displayName, password } });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, cookie: `bop_session=${token[1]}` };
}

async function request(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return requestOn(baseUrl, method, path, options);
}

async function requestOn(
  url: string,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : null };
}

async function listenApp(app: ReturnType<typeof createApp>) {
  const active = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => active.once("listening", () => resolve()));
  return {
    base: `http://127.0.0.1:${(active.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => active.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function removePaymentFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@payment.test')`;
  const orgs = `(SELECT organization_id FROM organization_memberships WHERE user_id IN ${owners})`;
  const orderIds = `(SELECT id FROM orders WHERE customer_user_id IN ${owners} OR organization_id IN ${orgs})`;
  await active.query(`DELETE FROM financial_transactions WHERE order_id IN ${orderIds}`);
  await active.query(`DELETE FROM payment_reconciliations WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE order_id IN ${orderIds})`);
  await active.query(`DELETE FROM payment_provider_events WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE order_id IN ${orderIds})`);
  await active.query(`DELETE FROM payment_attempts WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE order_id IN ${orderIds})`);
  await active.query(`DELETE FROM payment_intents WHERE order_id IN ${orderIds}`);
  await active.query(`DELETE FROM orders WHERE customer_user_id IN ${owners} OR organization_id IN ${orgs}`);
  await active.query(`DELETE FROM commercial_listings WHERE organization_id IN ${orgs}`);
  await active.query(`DELETE FROM fit_analyses WHERE profile_id IN (SELECT id FROM measurement_profiles WHERE subject_user_id IN ${owners})`);
  await active.query(`DELETE FROM measurement_profiles WHERE subject_user_id IN ${owners}`);
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs}`);
  await active.query(`DELETE FROM media_assets WHERE owner_organization_id IN ${orgs} OR owner_user_id IN ${owners}`);
  await active.query(`DELETE FROM organizations WHERE id IN ${orgs}`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@payment.test'`);
}
