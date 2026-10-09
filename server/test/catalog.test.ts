import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool, withTransaction } from "../src/db/pool";
import { createOrganization } from "../src/modules/organizations";

const password = "catalog-pass";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Garment = {
  id: string;
  name: string;
  visibility: string;
  access: string;
  garmentType: { kind: string; slug: string } | null;
  terms: { kind: string; slug: string }[];
  sizeLabels: { system: string; label: string }[];
  measurements: { definition: string; value: string; sizeLabel: string | null; unit: string; provenance: string }[];
  media: { role: string; storageKey?: string }[];
  organization: { slug: string; kind: string } | null;
  createdBy: { displayName: string } | null;
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so catalog tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so catalog tests were not executed.");
  await migrate(pool);
  await removeCatalogFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (pool) await removeCatalogFixtures(pool);
  await closePool();
});

test("kente stays a material and a textile tradition, and agbada stays a garment type", async () => {
  assert.ok(pool);
  const kinds = await pool.query<{ kind: string; slug: string }>(
    `SELECT kind, slug FROM fashion_terms WHERE slug IN ('kente', 'agbada', 'ankara') ORDER BY slug, kind`,
  );
  assert.deepEqual(
    kinds.rows.map((row) => `${row.kind}:${row.slug}`),
    ["garment_type:agbada", "material:ankara", "material:kente", "tradition:kente"],
  );
});

test("anonymous callers cannot create or read a private garment", async () => {
  const denied = await request("POST", "/api/v1/catalog/garments", { body: { name: "Hidden" } });
  assert.equal(denied.status, 401);

  const maker = await register("Maker");
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie: maker.cookie,
    body: {
      name: "Private agbada",
      terms: [
        { kind: "garment_type", slug: "agbada" },
        { kind: "material", slug: "ankara" },
        { kind: "pattern", slug: "floral" },
        { kind: "style", slug: "casual" },
      ],
      sizeLabels: [{ system: "letter", label: "M" }],
    },
  });
  assert.equal(created.status, 201);
  const garment = (created.body as { garment: Garment }).garment;
  assert.equal(garment.visibility, "private");
  assert.equal(garment.access, "edit");
  assert.equal(garment.garmentType?.slug, "agbada");
  assert.equal(garment.createdBy?.displayName, "Maker");
  assert.ok(garment.terms.some((term) => term.kind === "material" && term.slug === "ankara"));
  assert.deepEqual(garment.sizeLabels, [{ system: "letter", label: "M" }]);

  const hidden = await request("GET", `/api/v1/catalog/garments/${garment.id}`);
  assert.equal(hidden.status, 404);
  const listed = await request("GET", "/api/v1/catalog/garments?material=ankara");
  const ids = ((listed.body as { garments: Garment[] }).garments ?? []).map((item) => item.id);
  assert.equal(ids.includes(garment.id), false);

  const outsider = await register("Outsider");
  const peeked = await request("GET", `/api/v1/catalog/garments/${garment.id}`, { cookie: outsider.cookie });
  assert.equal(peeked.status, 404);
});

test("a public garment is readable without its storage key, and another organization cannot edit it", async () => {
  const owner = await register("Owner");
  const other = await register("Other");
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie: owner.cookie,
    body: { name: "Published gown", visibility: "private", terms: [{ kind: "garment_type", slug: "gown" }] },
  });
  const id = (created.body as { garment: Garment }).garment.id;
  const media = await request("POST", `/api/v1/catalog/garments/${id}/media`, {
    cookie: owner.cookie,
    body: {
      role: "front",
      mediaType: "image",
      mimeType: "image/png",
      byteSize: 40,
      storageKey: `catalog/${id}/front.png`,
    },
  });
  assert.equal(media.status, 201);
  assert.equal((media.body as { garment: Garment }).garment.media[0]?.storageKey, `catalog/${id}/front.png`);

  const published = await request("PATCH", `/api/v1/catalog/garments/${id}`, {
    cookie: owner.cookie,
    body: { visibility: "public" },
  });
  assert.equal(published.status, 200);

  const anonymous = await request("GET", `/api/v1/catalog/garments/${id}`);
  assert.equal(anonymous.status, 200);
  const publicGarment = (anonymous.body as { garment: Garment }).garment;
  assert.equal(publicGarment.access, "view");
  assert.equal(publicGarment.media[0]?.role, "front");
  assert.equal("storageKey" in (publicGarment.media[0] ?? {}), false);

  const edited = await request("PATCH", `/api/v1/catalog/garments/${id}`, {
    cookie: other.cookie,
    body: { name: "Taken" },
  });
  assert.equal(edited.status, 404);
  const health = await request("GET", "/api/v1/health");
  assert.equal(health.status, 200);
});

test("organization garments stay inside that organization", async () => {
  assert.ok(pool);
  const tailor = await register("Tailor");
  const stranger = await register("Stranger");
  const slug = `catalog-test-${randomUUID().slice(0, 8)}`;
  const organization = await withTransaction((client) =>
    createOrganization(client, tailor.id, { name: "Catalog House", slug, kind: "tailor" }),
  );
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie: tailor.cookie,
    body: { name: "House agbada", organizationId: organization.id, terms: [{ kind: "garment_type", slug: "agbada" }] },
  });
  assert.equal(created.status, 201);
  const garment = (created.body as { garment: Garment }).garment;
  assert.equal(garment.organization?.kind, "tailor");
  assert.equal(garment.createdBy?.displayName, "Tailor");

  const denied = await request("GET", `/api/v1/catalog/garments/${garment.id}`, { cookie: stranger.cookie });
  assert.equal(denied.status, 404);
  const seen = await request("GET", `/api/v1/catalog/garments/${garment.id}`, { cookie: tailor.cookie });
  assert.equal(seen.status, 200);
});

test("filters and pages return only matching accessible garments", async () => {
  assert.ok(pool);
  const slug = `catalog-test-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO fashion_terms (kind, name, slug) VALUES ('pattern', 'Catalog test', $1)
     ON CONFLICT (kind, slug) DO NOTHING`,
    [slug],
  );
  const maker = await register("Filter");
  await request("POST", "/api/v1/catalog/garments", {
    cookie: maker.cookie,
    body: {
      name: "Ankara wave",
      visibility: "public",
      terms: [
        { kind: "material", slug: "ankara" },
        { kind: "pattern", slug },
      ],
    },
  });
  await request("POST", "/api/v1/catalog/garments", {
    cookie: maker.cookie,
    body: {
      name: "Silk wave",
      visibility: "public",
      terms: [
        { kind: "material", slug: "silk" },
        { kind: "pattern", slug },
      ],
    },
  });
  const filtered = await request("GET", `/api/v1/catalog/garments?material=ankara&pattern=${slug}&limit=1&offset=0`);
  const body = filtered.body as { garments: Garment[]; page: { limit: number; offset: number; total: number } };
  assert.equal(filtered.status, 200);
  assert.equal(body.page.total, 1);
  assert.equal(body.page.limit, 1);
  assert.equal(body.garments.length, 1);
  assert.equal(body.garments[0]?.name, "Ankara wave");

  const firstPage = await request("GET", `/api/v1/catalog/garments?pattern=${slug}&limit=1&offset=0`);
  const secondPage = await request("GET", `/api/v1/catalog/garments?pattern=${slug}&limit=1&offset=1`);
  const first = firstPage.body as { garments: Garment[]; page: { total: number } };
  const second = secondPage.body as { garments: Garment[]; page: { total: number } };
  assert.equal(first.page.total, 2);
  assert.equal(second.page.total, 2);
  assert.equal(first.garments.length, 1);
  assert.equal(second.garments.length, 1);
  assert.notEqual(first.garments[0]?.id, second.garments[0]?.id);
});

test("the same size label can describe different garment measurements", async () => {
  const maker = await register("Cutter");
  const first = await createMeasured(maker.cookie, "Narrow", 96);
  const second = await createMeasured(maker.cookie, "Wide", 112);
  assert.equal(first.measurements[0]?.sizeLabel, "M");
  assert.equal(second.measurements[0]?.sizeLabel, "M");
  assert.equal(first.measurements[0]?.unit, "cm");
  assert.equal(first.measurements[0]?.provenance, "stated");
  assert.notEqual(Number(first.measurements[0]?.value), Number(second.measurements[0]?.value));

  const duplicate = await request("POST", `/api/v1/catalog/garments/${first.id}/measurements`, {
    cookie: maker.cookie,
    body: { definition: "chest", value: 97, size: { system: "letter", label: "M" } },
  });
  assert.equal(duplicate.status, 400);
  assert.equal((duplicate.body as { error: { code: string } }).error.code, "duplicate_measurement");
});

test("a material cannot be stored as a garment type", async () => {
  const maker = await register("Typist");
  const response = await request("POST", "/api/v1/catalog/garments", {
    cookie: maker.cookie,
    body: { name: "Wrong type", terms: [{ kind: "garment_type", slug: "ankara" }] },
  });
  assert.equal(response.status, 400);
  assert.equal((response.body as { error: { code: string } }).error.code, "unknown_term");
});

async function createMeasured(cookie: string, name: string, chest: number): Promise<Garment> {
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie,
    body: { name, sizeLabels: [{ system: "letter", label: "M" }] },
  });
  assert.equal(created.status, 201);
  const id = (created.body as { garment: Garment }).garment.id;
  const measured = await request("POST", `/api/v1/catalog/garments/${id}/measurements`, {
    cookie,
    body: { definition: "chest", value: chest, size: { system: "letter", label: "M" } },
  });
  assert.equal(measured.status, 201);
  return (measured.body as { garment: Garment }).garment;
}

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  const response = await request("POST", "/api/v1/auth/register", {
    body: { email: `${randomUUID()}@catalog.test`, displayName, password },
  });
  assert.equal(response.status, 201);
  const header = response.headers.get("set-cookie") ?? "";
  const token = header.match(/bop_session=([^;]+)/);
  assert.ok(token);
  const user = (response.body as { user: { id: string } }).user;
  return { id: user.id, cookie: `bop_session=${token[1]}` };
}

async function request(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  return { status: response.status, body, headers: response.headers };
}

async function removeCatalogFixtures(active: Pool) {
  await active.query(`
    DELETE FROM garment_measurements
    WHERE garment_id IN (
      SELECT id FROM garments
      WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR created_by_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR owner_organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'catalog-test-%')
    )
  `);
  await active.query(`
    DELETE FROM garment_size_labels
    WHERE garment_id IN (
      SELECT id FROM garments
      WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR created_by_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR owner_organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'catalog-test-%')
    )
  `);
  await active.query(`
    DELETE FROM garment_media
    WHERE garment_id IN (
      SELECT id FROM garments
      WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR created_by_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR owner_organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'catalog-test-%')
    )
  `);
  await active.query(`
    DELETE FROM garment_terms
    WHERE garment_id IN (
      SELECT id FROM garments
      WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR created_by_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
         OR owner_organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'catalog-test-%')
    )
  `);
  await active.query(`
    DELETE FROM garments
    WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
       OR created_by_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
       OR owner_organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'catalog-test-%')
  `);
  await active.query(`
    DELETE FROM media_assets
    WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
       OR owner_organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'catalog-test-%')
  `);
  await active.query(`
    DELETE FROM organization_memberships
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@catalog.test')
       OR organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'catalog-test-%')
  `);
  await active.query(`DELETE FROM organizations WHERE slug LIKE 'catalog-test-%'`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@catalog.test'`);
  await active.query(`DELETE FROM fashion_terms WHERE slug LIKE 'catalog-test-%'`);
}
