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

const password = "commerce-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Listing = {
  id: string;
  status: string;
  offering: string;
  pricing: { method: string; currency: string | null; amountMinor: number | null; amountMaxMinor: number | null; converted: boolean };
  garment: { id: string; name: string; terms: { kind: string; slug: string }[] } | null;
  design: { revisionNumber: number; projectName: string } | null;
  media: { id: string }[];
  verified: boolean;
  availability: string;
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so commerce tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so commerce tests were not executed.");
  await migrate(pool);
  await removeCommerceFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeCommerceFixtures(pool);
  await closePool();
});

test("a business profile stays unpublished and unverified until the owner publishes it", async () => {
  const owner = await register("Owner");
  const stranger = await register("Stranger");
  const anonymous = await request("POST", "/api/v1/commerce/businesses", { body: { name: "No", slug: "no", kind: "tailor" } });
  assert.equal(anonymous.status, 401);
  const created = await request("POST", "/api/v1/commerce/businesses", {
    cookie: owner.cookie,
    body: { name: "Ada Atelier", slug: `ada-${owner.id.slice(0, 8)}`, kind: "tailor" },
  });
  assert.equal(created.status, 201);
  const business = (created.body as { business: { id: string; verified: boolean; publication: string; specialties: string[] } }).business;
  assert.equal(business.verified, false);
  assert.equal(business.publication, "draft");
  assert.deepEqual(business.specialties, ["tailor"]);
  const hidden = await request("GET", `/api/v1/commerce/businesses/${business.id}`, { cookie: stranger.cookie });
  assert.equal(hidden.status, 404);
  const published = await request("PATCH", `/api/v1/commerce/businesses/${business.id}`, {
    cookie: owner.cookie,
    body: { description: "Bespoke and ready pieces", specialties: ["tailor", "retailer"], publication: "published" },
  });
  assert.equal(published.status, 200);
  const view = (published.body as { business: { verified: boolean; specialties: string[] } }).business;
  assert.equal(view.verified, false);
  assert.deepEqual(view.specialties.sort(), ["retailer", "tailor"]);
  const publicView = await request("GET", `/api/v1/commerce/businesses/${business.id}`);
  assert.equal(publicView.status, 200);
  const bad = await request("PATCH", `/api/v1/commerce/businesses/${business.id}`, {
    cookie: owner.cookie,
    body: { verified: true },
  });
  assert.equal(bad.status, 400);
});

test("listings keep seller prices apart from the catalog and from each other", async () => {
  assert.ok(pool);
  const maker = await register("Maker");
  const shop = await register("Shop");
  const member = await register("Member");
  const stranger = await register("Guest");
  const makerBusiness = await business(maker.cookie, "Maker House", "brand");
  const shopBusiness = await business(shop.cookie, "Shop House", "retailer");
  await withTransaction((client) => addMember(client, maker.id, { organizationId: makerBusiness, userId: member.id, role: "member" }));
  const garmentId = await garment(maker.cookie, makerBusiness, "Indigo shirt", "shirt", ["M"]);
  const negative = await request("POST", `/api/v1/commerce/businesses/${makerBusiness}/listings`, {
    cookie: maker.cookie,
    body: { offering: "ready_to_wear", title: "Bad", garmentId, pricingMethod: "fixed", currency: "NGN", amountMinor: -1 },
  });
  assert.equal(negative.status, 400);
  const decimal = await request("POST", `/api/v1/commerce/businesses/${makerBusiness}/listings`, {
    cookie: maker.cookie,
    body: { offering: "ready_to_wear", title: "Bad", garmentId, pricingMethod: "fixed", currency: "NGN", amountMinor: 10.5 },
  });
  assert.equal(decimal.status, 400);
  const lower = await request("POST", `/api/v1/commerce/businesses/${makerBusiness}/listings`, {
    cookie: maker.cookie,
    body: { offering: "ready_to_wear", title: "Bad", garmentId, pricingMethod: "fixed", currency: "ngn", amountMinor: 100 },
  });
  assert.equal(lower.status, 400);
  const created = await request("POST", `/api/v1/commerce/businesses/${makerBusiness}/listings`, {
    cookie: maker.cookie,
    body: {
      offering: "ready_to_wear",
      title: "Indigo shirt",
      garmentId,
      size: { system: "letter", label: "M" },
      pricingMethod: "fixed",
      currency: "NGN",
      amountMinor: 2500000,
      availability: "available",
    },
  });
  assert.equal(created.status, 201);
  const draft = (created.body as { listing: Listing }).listing;
  assert.equal(draft.status, "draft");
  assert.equal(draft.pricing.amountMinor, 2500000);
  assert.equal(draft.pricing.converted, false);
  assert.equal(draft.verified, false);
  const hidden = await request("GET", `/api/v1/commerce/listings/${draft.id}`);
  assert.equal(hidden.status, 404);
  const memberPublish = await request("POST", `/api/v1/commerce/listings/${draft.id}/status`, {
    cookie: member.cookie,
    body: { status: "published" },
  });
  assert.equal(memberPublish.status, 403);
  const published = await request("POST", `/api/v1/commerce/listings/${draft.id}/status`, {
    cookie: maker.cookie,
    body: { status: "published" },
  });
  assert.equal(published.status, 200);
  const back = await request("POST", `/api/v1/commerce/listings/${draft.id}/status`, {
    cookie: maker.cookie,
    body: { status: "draft" },
  });
  assert.equal(back.status, 400);
  const shopListing = await request("POST", `/api/v1/commerce/businesses/${shopBusiness}/listings`, {
    cookie: shop.cookie,
    body: {
      offering: "ready_to_wear",
      title: "Shop indigo shirt",
      garmentId,
      pricingMethod: "starting",
      currency: "USD",
      amountMinor: 80,
      availability: "unspecified",
    },
  });
  assert.equal(shopListing.status, 404);
  await request("PATCH", `/api/v1/catalog/garments/${garmentId}`, { cookie: maker.cookie, body: { visibility: "public" } });
  const shared = await request("POST", `/api/v1/commerce/businesses/${shopBusiness}/listings`, {
    cookie: shop.cookie,
    body: {
      offering: "ready_to_wear",
      title: "Shop indigo shirt",
      garmentId,
      pricingMethod: "starting",
      currency: "USD",
      amountMinor: 8000,
    },
  });
  assert.equal(shared.status, 201);
  const shopView = (shared.body as { listing: Listing }).listing;
  await request("POST", `/api/v1/commerce/listings/${shopView.id}/status`, { cookie: shop.cookie, body: { status: "published" } });
  const changed = await request("PATCH", `/api/v1/commerce/listings/${shopView.id}`, {
    cookie: shop.cookie,
    body: {
      offering: "ready_to_wear",
      title: "Shop indigo shirt",
      garmentId,
      pricingMethod: "starting",
      currency: "USD",
      amountMinor: 9000,
    },
  });
  assert.equal(changed.status, 200);
  const makerStill = await request("GET", `/api/v1/commerce/listings/${draft.id}`, { cookie: maker.cookie });
  assert.equal((makerStill.body as { listing: Listing }).listing.pricing.amountMinor, 2500000);
  const cross = await request("PATCH", `/api/v1/commerce/listings/${draft.id}`, {
    cookie: shop.cookie,
    body: {
      offering: "ready_to_wear",
      title: "Taken",
      garmentId,
      pricingMethod: "fixed",
      currency: "NGN",
      amountMinor: 1,
    },
  });
  assert.equal(cross.status, 404);
  const catalog = await request("GET", `/api/v1/catalog/garments/${garmentId}`, { cookie: stranger.cookie });
  const measurements = (catalog.body as { garment: { measurements: unknown[] } }).garment.measurements;
  assert.equal(measurements.length, 0);
  const discovered = await request("GET", "/api/v1/commerce/listings?type=shirt&currency=NGN&material=ankara");
  assert.equal(discovered.status, 200);
  assert.equal((discovered.body as { listings: Listing[] }).listings.some((item) => item.id === draft.id), true);
  assert.equal((discovered.body as { listings: Listing[] }).listings.some((item) => item.id === shopView.id), false);
  const priced = await request("GET", "/api/v1/commerce/listings?minMinor=9000&maxMinor=9000");
  const pricedIds = (priced.body as { listings: Listing[] }).listings.map((item) => item.id);
  assert.equal(pricedIds.includes(shopView.id), true);
  assert.equal(pricedIds.includes(draft.id), false);
});

test("services, quotes, and private designs stay within the business", async () => {
  assert.ok(pool);
  const tailor = await register("Tailor");
  const outsider = await register("Outsider");
  const businessId = await business(tailor.cookie, "Needle House", "tailor");
  const quote = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: tailor.cookie,
    body: {
      offering: "custom_service",
      title: "Agbada commission",
      description: "Bespoke agbada. Price is quoted.",
      pricingMethod: "quote",
      customizationNote: "Fabric supplied by the client",
      turnaroundNote: "Discussed after the quote",
    },
  });
  assert.equal(quote.status, 201);
  const service = (quote.body as { listing: Listing }).listing;
  assert.equal(service.pricing.method, "quote");
  assert.equal(service.pricing.currency, null);
  assert.equal(service.garment, null);
  const range = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: tailor.cookie,
    body: { offering: "custom_service", title: "Alterations", pricingMethod: "range", currency: "NGN", amountMinor: 500000, amountMaxMinor: 1500000 },
  });
  assert.equal(range.status, 201);
  const backwards = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: tailor.cookie,
    body: { offering: "custom_service", title: "Alterations", pricingMethod: "range", currency: "NGN", amountMinor: 1500, amountMaxMinor: 500 },
  });
  assert.equal(backwards.status, 400);
  const project = await request("POST", "/api/v1/design-projects", {
    cookie: tailor.cookie,
    body: { name: "Private gown", organizationId: businessId, description: "Private notes" },
  });
  assert.equal(project.status, 201);
  const projectId = (project.body as { project: { id: string } }).project.id;
  const revision = await request("POST", `/api/v1/design-projects/${projectId}/revisions`, { cookie: tailor.cookie, body: {} });
  assert.equal(revision.status, 201);
  const revisionId = (revision.body as { revision: { id: string } }).revision.id;
  const personal = await request("POST", "/api/v1/design-projects", {
    cookie: outsider.cookie,
    body: { name: "Personal sketch" },
  });
  const personalId = (personal.body as { project: { id: string } }).project.id;
  const personalRevision = await request("POST", `/api/v1/design-projects/${personalId}/revisions`, { cookie: outsider.cookie, body: {} });
  const personalRevisionId = (personalRevision.body as { revision: { id: string } }).revision.id;
  const stolen = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: tailor.cookie,
    body: { offering: "design_commission", title: "Stolen", designRevisionId: personalRevisionId, pricingMethod: "quote" },
  });
  assert.equal(stolen.status, 404);
  const commission = await request("POST", `/api/v1/commerce/businesses/${businessId}/listings`, {
    cookie: tailor.cookie,
    body: { offering: "design_commission", title: "Gown commission", designRevisionId: revisionId, pricingMethod: "starting", currency: "NGN", amountMinor: 4000000 },
  });
  assert.equal(commission.status, 201);
  const offer = (commission.body as { listing: Listing }).listing;
  assert.equal(offer.design?.revisionNumber, 2);
  assert.equal(JSON.stringify(offer).includes("Private notes"), false);
  await request("POST", `/api/v1/commerce/listings/${service.id}/status`, { cookie: tailor.cookie, body: { status: "published" } });
  await request("POST", `/api/v1/commerce/listings/${service.id}/status`, { cookie: tailor.cookie, body: { status: "paused" } });
  const paused = await request("GET", "/api/v1/commerce/listings?offering=custom_service");
  assert.equal((paused.body as { listings: Listing[] }).listings.some((item) => item.id === service.id), false);
  await request("POST", `/api/v1/commerce/listings/${service.id}/status`, { cookie: tailor.cookie, body: { status: "archived" } });
  const archived = await request("POST", `/api/v1/commerce/listings/${service.id}/status`, {
    cookie: tailor.cookie,
    body: { status: "published" },
  });
  assert.equal(archived.status, 400);
  const mediaId = randomUUID();
  await pool.query(
    `INSERT INTO media_assets (id, owner_organization_id, media_type, mime_type, byte_size, storage_key, status, visibility)
     VALUES ($1, $2, 'image', 'image/png', 10, $3, 'ready', 'private')`,
    [mediaId, businessId, `commerce/${mediaId}.png`],
  );
  const attached = await request("POST", `/api/v1/commerce/listings/${offer.id}/media`, {
    cookie: tailor.cookie,
    body: { mediaId },
  });
  assert.equal(attached.status, 200);
  assert.equal((attached.body as { listing: Listing }).listing.media.length, 1);
  await request("POST", `/api/v1/commerce/listings/${offer.id}/status`, { cookie: tailor.cookie, body: { status: "published" } });
  const publicOffer = await request("GET", `/api/v1/commerce/listings/${offer.id}`);
  assert.equal(publicOffer.status, 200);
  assert.equal((publicOffer.body as { listing: Listing }).listing.media.length, 0);
  const empty = await request("GET", "/api/v1/commerce/listings?organization=missing-house");
  assert.equal((empty.body as { listings: Listing[] }).listings.length, 0);
});

async function business(cookie: string, name: string, kind: string): Promise<string> {
  const slug = `${kind}-${randomUUID().slice(0, 8)}`;
  const response = await request("POST", "/api/v1/commerce/businesses", { cookie, body: { name, slug, kind } });
  assert.equal(response.status, 201);
  return (response.body as { business: { id: string } }).business.id;
}

async function garment(cookie: string, organizationId: string, name: string, type: string, labels: string[]): Promise<string> {
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie,
    body: {
      organizationId,
      name,
      terms: [
        { kind: "garment_type", slug: type },
        { kind: "material", slug: "ankara" },
        { kind: "color", slug: "indigo" },
      ],
      sizeLabels: labels.map((label) => ({ system: "letter", label })),
    },
  });
  assert.equal(created.status, 201);
  return (created.body as { garment: { id: string } }).garment.id;
}

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  const email = `${randomUUID()}@commerce.test`;
  const response = await request("POST", "/api/v1/auth/register", { body: { email, displayName, password } });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, cookie: `bop_session=${token[1]}` };
}

async function request(method: string, path: string, options: { cookie?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : null };
}

async function removeCommerceFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@commerce.test')`;
  const orgs = `(SELECT organization_id FROM organization_memberships WHERE user_id IN ${owners})`;
  await active.query(`DELETE FROM commercial_listings WHERE organization_id IN ${orgs}`);
  await active.query(`DELETE FROM design_projects WHERE owner_organization_id IN ${orgs} OR owner_user_id IN ${owners} OR created_by_user_id IN ${owners}`);
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garments WHERE created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs}`);
  await active.query(`DELETE FROM media_assets WHERE owner_organization_id IN ${orgs} OR owner_user_id IN ${owners}`);
  await active.query(`DELETE FROM organizations WHERE id IN ${orgs}`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@commerce.test'`);
}
