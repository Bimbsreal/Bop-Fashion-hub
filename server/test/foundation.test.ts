import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { DomainError } from "../src/errors";
import { migrate, withRollback } from "../src/db/migrate";
import { closePool, getPool } from "../src/db/pool";
import { assertCanActForOwner } from "../src/modules/access";
import { createGarment, setGarmentType } from "../src/modules/fashion";
import { createUser } from "../src/modules/identity";
import { linkGarmentMedia, registerMedia } from "../src/modules/media";
import { addMember, createOrganization } from "../src/modules/organizations";

const databaseUrl = process.env.DATABASE_URL;
let pool: Pool | null = null;

before(async () => {
  if (!databaseUrl) return;
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set.");
  await migrate(pool);
});

after(async () => {
  await closePool();
});

test("applying migrations again changes nothing", async () => {
  assert.ok(pool);
  const applied = await migrate(pool);
  assert.deepEqual(applied, []);
});

test("health reports the database when configured", async () => {
  if (!databaseUrl) {
    assert.fail("DATABASE_URL is not set, so the health check was not executed.");
  }
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
    const body = (await response.json()) as { ok: boolean; database: string };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.database, "ok");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("one person can belong to more than one organization", async () => {
  assert.ok(pool);
  await withRollback(pool, async (client) => {
    const user = await createUser(client, {
      email: "ada@example.com",
      displayName: "Ada",
    });
    const studio = await createOrganization(client, user.id, {
      name: "Ada Studio",
      slug: "ada-studio",
      kind: "studio",
    });
    const shop = await createOrganization(client, user.id, {
      name: "Ada Shop",
      slug: "ada-shop",
      kind: "retailer",
    });
    const profile = await client.query(`SELECT user_id FROM user_profiles WHERE user_id = $1`, [user.id]);
    assert.equal(profile.rowCount, 1);
    const memberships = await client.query(
      `SELECT organization_id FROM organization_memberships WHERE user_id = $1 AND status = 'active'`,
      [user.id],
    );
    assert.equal(memberships.rowCount, 2);
    assert.notEqual(studio.id, shop.id);
  });
});

test("a member of one organization cannot act for another", async () => {
  assert.ok(pool);
  await withRollback(pool, async (client) => {
    const ada = await createUser(client, { email: "ada2@example.com", displayName: "Ada" });
    const bola = await createUser(client, { email: "bola@example.com", displayName: "Bola" });
    const studio = await createOrganization(client, ada.id, {
      name: "Studio A",
      slug: "studio-a",
      kind: "studio",
    });
    await createOrganization(client, bola.id, {
      name: "House B",
      slug: "house-b",
      kind: "brand",
    });

    await assert.rejects(
      () => assertCanActForOwner(client, bola.id, { organizationId: studio.id }),
      (error: unknown) => error instanceof DomainError && error.code === "forbidden",
    );

    await assert.rejects(
      () =>
        addMember(client, bola.id, {
          organizationId: studio.id,
          userId: bola.id,
          role: "admin",
        }),
      (error: unknown) => error instanceof DomainError && error.code === "forbidden",
    );
    await assert.rejects(
      () =>
        createGarment(client, bola.id, {
          owner: { organizationId: studio.id },
          name: "Outside the studio",
        }),
      (error: unknown) => error instanceof DomainError && error.code === "forbidden",
    );
  });
});

test("a garment keeps one owner and can carry several fashion terms", async () => {
  assert.ok(pool);
  await withRollback(pool, async (client) => {
    const user = await createUser(client, { email: "tailor@example.com", displayName: "Tailor" });
    const house = await createOrganization(client, user.id, {
      name: "House",
      slug: "house",
      kind: "tailor",
    });
    const garment = await createGarment(client, user.id, {
      owner: { organizationId: house.id },
      name: "Ceremony agbada",
      termSlugs: ["ankara", "agbada", "contemporary-african"],
    });
    await setGarmentType(client, user.id, garment.id, "agbada");

    const terms = await client.query<{ kind: string; slug: string }>(
      `SELECT kind, slug
       FROM garment_terms
       JOIN fashion_terms ON fashion_terms.id = garment_terms.term_id
       WHERE garment_id = $1
       ORDER BY slug`,
      [garment.id],
    );
    assert.deepEqual(
      terms.rows.map((row) => row.slug),
      ["agbada", "ankara", "contemporary-african"],
    );
    assert.equal(garment.owner_organization_id, house.id);
    assert.equal(garment.owner_user_id, null);

    await client.query("SAVEPOINT owner_check");
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO garments (owner_user_id, owner_organization_id, name)
           VALUES ($1, $2, 'Both owners')`,
          [user.id, house.id],
        ),
      /garments_one_owner/,
    );
    await client.query("ROLLBACK TO SAVEPOINT owner_check");

    await client.query("SAVEPOINT type_check");
    await assert.rejects(
      () =>
        client.query(
          `UPDATE garments
           SET garment_type_id = (SELECT id FROM fashion_terms WHERE kind = 'material' AND slug = 'ankara')
           WHERE id = $1`,
          [garment.id],
        ),
      /garment_type_id must reference a garment_type term/,
    );
    await client.query("ROLLBACK TO SAVEPOINT type_check");
  });
});

test("media metadata does not store file bytes", async () => {
  assert.ok(pool);
  await withRollback(pool, async (client) => {
    const user = await createUser(client, { email: "maker@example.com", displayName: "Maker" });
    const media = await registerMedia(client, user.id, {
      owner: { userId: user.id },
      mediaType: "image",
      mimeType: "image/png",
      byteSize: 1200,
      storageKey: "orgs/example/look.png",
      widthPx: 800,
      heightPx: 1000,
    });
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'media_assets' AND data_type = 'bytea'`,
    );
    assert.equal(columns.rowCount, 0);
    assert.equal(media.storage_key, "orgs/example/look.png");
    assert.equal(media.status, "pending");
    await assert.rejects(
      () =>
        registerMedia(client, user.id, {
          owner: { userId: user.id },
          mediaType: "image",
          mimeType: "image/png",
          byteSize: 10,
          storageKey: "../secret.png",
        }),
      (error: unknown) => error instanceof DomainError && error.code === "invalid_media",
    );

    const garment = await createGarment(client, user.id, {
      owner: { userId: user.id },
      name: "Personal look",
    });
    await linkGarmentMedia(client, user.id, { garmentId: garment.id, mediaId: media.id, role: "primary" });
    const link = await client.query<{ role: string }>(`SELECT role FROM garment_media WHERE garment_id = $1 AND media_id = $2`, [
      garment.id,
      media.id,
    ]);
    assert.equal(link.rows[0]?.role, "primary");

    const outsider = await createUser(client, { email: "other@example.com", displayName: "Other" });
    await assert.rejects(
      () =>
        registerMedia(client, outsider.id, {
          owner: { userId: user.id },
          mediaType: "image",
          mimeType: "image/png",
          byteSize: 10,
          storageKey: "orgs/example/other.png",
        }),
      (error: unknown) => error instanceof DomainError && error.code === "forbidden",
    );
  });
});
