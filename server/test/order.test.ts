import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool, withTransaction } from "../src/db/pool";
import { addMember } from "../src/modules/organizations";

const password = "order-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Order = {
  id: string;
  status: string;
  offering: string;
  quantity: number;
  paid: boolean;
  stockReserved: boolean;
  customizationNote: string;
  pricing: {
    currency: string | null;
    unitAmountMinor: number | null;
    agreedAmountMinor: number | null;
    converted: boolean;
  };
  measurements: { definition: string; canonicalCm: string }[];
  media: { id: string }[];
  quotations: { id: string; status: string; amountMinor: number; currency: string }[];
  events: { toStatus: string; kind: string }[];
  role: string | null;
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so order tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so order tests were not executed.");
  await migrate(pool);
  await removeOrderFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeOrderFixtures(pool);
  await closePool();
});

test("a ready-to-wear order keeps its price after the listing changes", async () => {
  assert.ok(pool);
  const seller = await register("Seller");
  const buyer = await register("Buyer");
  const stranger = await register("Stranger");
  const member = await register("Member");
  const businessId = await business(seller.cookie, "Atelier");
  await withTransaction((client) => addMember(client, seller.id, { organizationId: businessId, userId: member.id, role: "member" }));
  const garmentId = await garment(seller.cookie, businessId);
  const draft = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: seller.cookie,
    body: {
      offering: "ready_to_wear",
      title: "Indigo shirt",
      garmentId,
      pricingMethod: "fixed",
      currency: "NGN",
      amountMinor: 2500,
      availability: "available",
    },
  });
  assert.equal(draft.status, 201);
  const listingId = (draft.body as { listing: { id: string } }).listing.id;
  const hidden = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId, quantity: 1 } });
  assert.equal(hidden.status, 404);
  await request("POST", `/api/v1/commerce/listings/${listingId}/status`, { cookie: seller.cookie, body: { status: "published" } });
  const badQuantity = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId, quantity: 0 } });
  assert.equal(badQuantity.status, 400);
  const priced = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId, quantity: 2, amountMinor: 1 } });
  assert.equal(priced.status, 400);
  const created = await request("POST", "/api/v1/orders", {
    cookie: buyer.cookie,
    body: { listingId, quantity: 2 },
    headers: { "idempotency-key": "shirt-order-1" },
  });
  assert.equal(created.status, 201);
  const order = (created.body as { order: Order }).order;
  assert.equal(order.status, "submitted");
  assert.equal(order.pricing.agreedAmountMinor, 5000);
  assert.equal(order.pricing.currency, "NGN");
  assert.equal(order.pricing.converted, false);
  assert.equal(order.paid, false);
  assert.equal(order.stockReserved, false);
  const duplicate = await request("POST", "/api/v1/orders", {
    cookie: buyer.cookie,
    body: { listingId, quantity: 2 },
    headers: { "idempotency-key": "shirt-order-1" },
  });
  assert.equal(duplicate.status, 200);
  assert.equal((duplicate.body as { order: Order; duplicate: boolean }).duplicate, true);
  assert.equal((duplicate.body as { order: Order }).order.id, order.id);
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
  const still = await request("GET", `/api/v1/orders/${order.id}`, { cookie: buyer.cookie });
  assert.equal((still.body as { order: Order }).order.pricing.agreedAmountMinor, 5000);
  const outsider = await request("GET", `/api/v1/orders/${order.id}`, { cookie: stranger.cookie });
  assert.equal(outsider.status, 404);
  const otherShop = await business(stranger.cookie, "Other");
  const cross = await request("GET", `/api/v1/orders?organizationId=${otherShop}`, { cookie: stranger.cookie });
  assert.equal((cross.body as { orders: Order[] }).orders.some((item) => item.id === order.id), false);
  const buyerStatus = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: buyer.cookie, body: { status: "completed" } });
  assert.equal(buyerStatus.status, 403);
  const memberStatus = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: member.cookie, body: { status: "confirmed" } });
  assert.equal(memberStatus.status, 403);
  const skip = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: seller.cookie, body: { status: "completed" } });
  assert.equal(skip.status, 400);
  const confirmed = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  assert.equal(confirmed.status, 200);
  const lateCancel = await request("POST", `/api/v1/orders/${order.id}/cancel`, { cookie: buyer.cookie });
  assert.equal(lateCancel.status, 400);
  const ready = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: seller.cookie, body: { status: "ready_for_fulfillment" } });
  assert.equal(ready.status, 200);
  const done = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: seller.cookie, body: { status: "completed" } });
  assert.equal(done.status, 200);
  assert.equal((done.body as { order: Order }).order.events.some((event) => event.toStatus === "completed"), true);
  const inbox = await request("GET", `/api/v1/orders?organizationId=${businessId}`, { cookie: seller.cookie });
  assert.equal((inbox.body as { orders: Order[] }).orders.some((item) => item.id === order.id), true);
});

test("a custom request keeps the accepted quotation and hides other measurements", async () => {
  assert.ok(pool);
  const tailor = await register("Tailor");
  const buyer = await register("Buyer");
  const businessId = await business(tailor.cookie, "Needle");
  const listing = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: tailor.cookie,
    body: { offering: "custom_service", title: "Agbada commission", pricingMethod: "quote" },
  });
  const listingId = (listing.body as { listing: { id: string } }).listing.id;
  await request("POST", `/api/v1/commerce/listings/${listingId}/status`, { cookie: tailor.cookie, body: { status: "published" } });
  const missing = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  assert.equal(missing.status, 400);
  const profile = await request("POST", "/api/v1/measurements/profiles", {
    cookie: buyer.cookie,
    body: { name: "Fitting", preferredUnit: "cm", notes: "Private measure notes" },
  });
  const profileId = (profile.body as { profile: { id: string } }).profile.id;
  const recorded = await request("POST", `/api/v1/measurements/profiles/${profileId}/measurements`, {
    cookie: buyer.cookie,
    body: { definition: "chest-circumference", value: "90", unit: "cm", source: "user_entered" },
  });
  const measurementId = (recorded.body as { measurement: { id: string } }).measurement.id;
  const other = await request("POST", `/api/v1/measurements/profiles/${profileId}/measurements`, {
    cookie: buyer.cookie,
    body: { definition: "waist-circumference", value: "70", unit: "cm", source: "user_entered" },
  });
  const otherId = (other.body as { measurement: { id: string } }).measurement.id;
  const stolen = await request("POST", "/api/v1/orders", {
    cookie: tailor.cookie,
    body: { listingId, customizationNote: "Bespoke", measurementIds: [measurementId] },
  });
  assert.equal(stolen.status, 404);
  const created = await request("POST", "/api/v1/orders", {
    cookie: buyer.cookie,
    body: { listingId, customizationNote: "Bespoke agbada", measurementIds: [measurementId] },
  });
  assert.equal(created.status, 201);
  const order = (created.body as { order: Order }).order;
  assert.equal(order.status, "awaiting_quotation");
  assert.equal(order.pricing.agreedAmountMinor, null);
  assert.equal(order.measurements.length, 1);
  assert.equal(order.measurements[0]?.canonicalCm, "90.00");
  assert.equal(JSON.stringify(created.body).includes("Private measure notes"), false);
  assert.equal(JSON.stringify(created.body).includes(otherId), false);
  const profilePeek = await request("GET", `/api/v1/measurements/profiles/${profileId}`, { cookie: tailor.cookie });
  assert.equal(profilePeek.status, 404);
  const tailorView = await request("GET", `/api/v1/orders/${order.id}`, { cookie: tailor.cookie });
  assert.equal((tailorView.body as { order: Order }).order.measurements.length, 1);
  const quote = await request("POST", `/api/v1/orders/${order.id}/quotations`, {
    cookie: tailor.cookie,
    body: { currency: "NGN", amountMinor: 4000000, note: "First quote", expiresAt: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(quote.status, 400);
  const issued = await request("POST", `/api/v1/orders/${order.id}/quotations`, {
    cookie: tailor.cookie,
    body: { currency: "NGN", amountMinor: 4000000, note: "First quote" },
  });
  assert.equal(issued.status, 201);
  const issuedOrder = (issued.body as { order: Order }).order;
  assert.equal(issuedOrder.status, "awaiting_customer_approval");
  const quoteId = issuedOrder.quotations[0]?.id;
  assert.ok(quoteId);
  const buyerQuote = await request("POST", `/api/v1/orders/${order.id}/quotations`, {
    cookie: buyer.cookie,
    body: { currency: "NGN", amountMinor: 1 },
  });
  assert.equal(buyerQuote.status, 403);
  const rejected = await request("POST", `/api/v1/orders/${order.id}/quotations/${quoteId}/reject`, { cookie: buyer.cookie });
  assert.equal((rejected.body as { order: Order }).order.status, "awaiting_quotation");
  const revised = await request("POST", `/api/v1/orders/${order.id}/quotations`, {
    cookie: tailor.cookie,
    body: { currency: "NGN", amountMinor: 4500000, note: "Revised" },
  });
  const revisedOrder = (revised.body as { order: Order }).order;
  const open = revisedOrder.quotations.find((item) => item.status === "issued");
  assert.ok(open);
  assert.equal(revisedOrder.quotations.some((item) => item.status === "rejected"), true);
  const accepted = await request("POST", `/api/v1/orders/${order.id}/quotations/${open.id}/accept`, { cookie: buyer.cookie });
  const confirmed = (accepted.body as { order: Order }).order;
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.pricing.currency, "NGN");
  assert.equal(confirmed.pricing.agreedAmountMinor, 4500000);
  assert.equal(confirmed.paid, false);
  const replace = await request("POST", `/api/v1/orders/${order.id}/quotations`, {
    cookie: tailor.cookie,
    body: { currency: "NGN", amountMinor: 100 },
  });
  assert.equal(replace.status, 400);
  const kept = await request("GET", `/api/v1/orders/${order.id}`, { cookie: buyer.cookie });
  assert.equal((kept.body as { order: Order }).order.pricing.agreedAmountMinor, 4500000);
  const expiredListing = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: tailor.cookie,
    body: { offering: "custom_service", title: "Alterations", pricingMethod: "range", currency: "NGN", amountMinor: 500, amountMaxMinor: 1500 },
  });
  const expiredListingId = (expiredListing.body as { listing: { id: string } }).listing.id;
  await request("POST", `/api/v1/commerce/listings/${expiredListingId}/status`, { cookie: tailor.cookie, body: { status: "published" } });
  const ranged = await request("POST", "/api/v1/orders", {
    cookie: buyer.cookie,
    body: { listingId: expiredListingId, customizationNote: "Hem" },
  });
  const rangedId = (ranged.body as { order: Order }).order.id;
  const outside = await request("POST", `/api/v1/orders/${rangedId}/quotations`, {
    cookie: tailor.cookie,
    body: { currency: "NGN", amountMinor: 2000 },
  });
  assert.equal(outside.status, 400);
  const short = await request("POST", `/api/v1/orders/${rangedId}/quotations`, {
    cookie: tailor.cookie,
    body: { currency: "NGN", amountMinor: 800, expiresAt: new Date(Date.now() + 60_000).toISOString() },
  });
  assert.equal(short.status, 201);
  const shortId = (short.body as { order: Order }).order.quotations.find((item) => item.status === "issued")?.id;
  await pool.query(`UPDATE order_quotations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [shortId]);
  const expired = await request("POST", `/api/v1/orders/${rangedId}/quotations/${shortId}/accept`, { cookie: buyer.cookie });
  assert.equal(expired.status, 400);
  assert.equal((expired.body as { error: { code: string } }).error.code, "expired_quotation");
});

test("a failed measurement reference does not leave an order", async () => {
  assert.ok(pool);
  const seller = await register("Maker");
  const buyer = await register("Client");
  const businessId = await business(seller.cookie, "Studio");
  const listing = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: seller.cookie,
    body: { offering: "made_to_order", title: "Commission shirt", pricingMethod: "fixed", currency: "USD", amountMinor: 80 },
  });
  const listingId = (listing.body as { listing: { id: string } }).listing.id;
  await request("POST", `/api/v1/commerce/listings/${listingId}/status`, { cookie: seller.cookie, body: { status: "published" } });
  const failed = await request("POST", "/api/v1/orders", {
    cookie: buyer.cookie,
    body: { listingId, measurementIds: [randomUUID()] },
  });
  assert.equal(failed.status, 404);
  const count = await pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM orders WHERE customer_user_id = $1`, [buyer.id]);
  assert.equal(count.rows[0]?.total, 0);
  const mediaId = randomUUID();
  await pool.query(
    `INSERT INTO media_assets (id, owner_user_id, media_type, mime_type, byte_size, storage_key, status, visibility)
     VALUES ($1, $2, 'image', 'image/png', 8, $3, 'ready', 'private')`,
    [mediaId, seller.id, `orders/${mediaId}.png`],
  );
  const foreign = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId, mediaIds: [mediaId] } });
  assert.equal(foreign.status, 404);
  const created = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  assert.equal(created.status, 201);
  const order = (created.body as { order: Order }).order;
  assert.equal(order.status, "submitted");
  const produced = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: seller.cookie, body: { status: "confirmed" } });
  assert.equal(produced.status, 200);
  const production = await request("POST", `/api/v1/orders/${order.id}/status`, { cookie: seller.cookie, body: { status: "in_production" } });
  assert.equal(production.status, 200);
  assert.equal((production.body as { order: Order }).order.pricing.agreedAmountMinor, 80);
  const closed = await request("POST", `/api/v1/commerce/listings/${listingId}`, { cookie: seller.cookie, body: { availability: "unavailable" } });
  assert.equal(closed.status, 404);
  await request("PATCH", `/api/v1/commerce/listings/${listingId}`, {
    cookie: seller.cookie,
    body: { offering: "made_to_order", title: "Commission shirt", pricingMethod: "fixed", currency: "USD", amountMinor: 80, availability: "unavailable" },
  });
  const blocked = await request("POST", "/api/v1/orders", { cookie: buyer.cookie, body: { listingId } });
  assert.equal(blocked.status, 400);
});

async function business(cookie: string, name: string): Promise<string> {
  const response = await request("POST", "/api/v1/commerce/businesses", {
    cookie,
    body: { name, slug: `shop-${randomUUID().slice(0, 8)}`, kind: "tailor" },
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
  const email = `${randomUUID()}@order.test`;
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
  const response = await fetch(`${baseUrl}${path}`, {
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

async function removeOrderFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@order.test')`;
  const orgs = `(SELECT organization_id FROM organization_memberships WHERE user_id IN ${owners})`;
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
  await active.query(`DELETE FROM users WHERE email LIKE '%@order.test'`);
}
