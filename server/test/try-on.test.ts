import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import sharp from "sharp";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool } from "../src/db/pool";

const password = "tryon-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type TryOn = {
  id: string;
  status: string;
  operational: boolean;
  configured: boolean;
  simulated: boolean;
  generated: boolean;
  fitClaim: boolean;
  output: null;
  message: string;
  garmentCategory: string;
  consent: { purpose: string };
  personMedia: { id: string };
  garmentMedia: { id: string };
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so try-on tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so try-on tests were not executed.");
  await migrate(pool);
  await removeTryOnFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeTryOnFixtures(pool);
  await closePool();
});

test("try-on stays unavailable and records a consented draft without generating an image", async () => {
  assert.ok(pool);
  const owner = await register("Owner");
  const stranger = await register("Stranger");
  const capability = await request("GET", "/api/v1/try-on/capability");
  const described = (capability.body as { capability: { operational: boolean; configured: boolean; supportedCategories: string[]; fitClaim: boolean } }).capability;
  assert.equal(capability.status, 200);
  assert.equal(described.operational, false);
  assert.equal(described.configured, false);
  assert.equal(described.fitClaim, false);
  assert.deepEqual(described.supportedCategories, []);

  const anonymous = await request("POST", "/api/v1/try-on", { body: { personMediaId: randomUUID() } });
  assert.equal(anonymous.status, 401);

  const person = await upload(owner.cookie, 256, "person.png");
  const garmentImage = await upload(owner.cookie, 256, "agbada.png");
  const garmentId = await garmentWithImage(owner.cookie, garmentImage, "front");
  const beforeKeys = await pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM media_assets WHERE id = ANY($1::uuid[]) ORDER BY storage_key`,
    [[person, garmentImage]],
  );

  const missingConsent = await submit(owner.cookie, { personMediaId: person, garmentId, garmentMediaId: garmentImage });
  assert.equal(missingConsent.status, 400);
  assert.equal((missingConsent.body as { error: { code: string } }).error.code, "consent_required");
  const training = await submit(owner.cookie, {
    personMediaId: person,
    garmentId,
    garmentMediaId: garmentImage,
    consent: { purpose: "try_on_request", training: true },
  });
  assert.equal(training.status, 400);

  const external = await submit(owner.cookie, {
    personMediaId: person,
    garmentId,
    garmentMediaId: garmentImage,
    consent: { purpose: "try_on_request" },
    url: "http://example.test/person.png",
  });
  assert.equal(external.status, 400);

  const foreign = await upload(stranger.cookie, 256, "private.png");
  const hidden = await submit(owner.cookie, {
    personMediaId: foreign,
    garmentId,
    garmentMediaId: garmentImage,
    consent: { purpose: "try_on_request" },
  });
  assert.equal(hidden.status, 404);
  const noneYet = await pool.query(`SELECT count(*)::int AS total FROM try_on_requests WHERE created_by_user_id = $1`, [owner.id]);
  assert.equal(Number(noneYet.rows[0]?.total ?? 0), 0);

  const tiny = await upload(owner.cookie, 8, "tiny.png");
  const tooSmall = await submit(owner.cookie, {
    personMediaId: tiny,
    garmentId,
    garmentMediaId: garmentImage,
    consent: { purpose: "try_on_request" },
  });
  assert.equal(tooSmall.status, 400);
  assert.equal((tooSmall.body as { error: { code: string } }).error.code, "invalid_media");

  const created = await submit(owner.cookie, {
    personMediaId: person,
    garmentId,
    garmentMediaId: garmentImage,
    garmentPresentation: "catalog",
    consent: { purpose: "try_on_request" },
  });
  assert.equal(created.status, 201);
  const requestView = (created.body as { request: TryOn }).request;
  assert.equal(requestView.status, "draft");
  assert.equal(requestView.operational, false);
  assert.equal(requestView.generated, false);
  assert.equal(requestView.simulated, false);
  assert.equal(requestView.output, null);
  assert.equal(requestView.fitClaim, false);
  assert.equal(requestView.garmentCategory, "agbada");
  assert.equal(requestView.consent.purpose, "try_on_request");
  assert.match(requestView.message, /No image was generated/);
  assert.equal(JSON.stringify(created.body).includes("storageKey"), false);

  const strangerRead = await request("GET", `/api/v1/try-on/${requestView.id}`, { cookie: stranger.cookie });
  assert.equal(strangerRead.status, 404);
  const saved = await request("POST", `/api/v1/try-on/${requestView.id}/save`, {
    cookie: owner.cookie,
    body: { visualizationId: randomUUID() },
  });
  assert.equal(saved.status, 400);
  assert.equal((saved.body as { error: { code: string } }).error.code, "invalid_result");

  const afterKeys = await pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM media_assets WHERE id = ANY($1::uuid[]) ORDER BY storage_key`,
    [[person, garmentImage]],
  );
  assert.deepEqual(afterKeys.rows, beforeKeys.rows);
  const tasks = await pool.query(`SELECT count(*)::int AS total FROM ai_tasks WHERE created_by_user_id = $1`, [owner.id]);
  assert.equal(Number(tasks.rows[0]?.total ?? 0), 0);
  const outputs = await pool.query(`SELECT output_media_id FROM try_on_requests WHERE id = $1`, [requestView.id]);
  assert.equal(outputs.rows[0]?.output_media_id ?? null, null);

  const queued = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "fashion.virtual_try_on", mediaIds: [person] },
  });
  assert.equal(queued.status, 400);
  const stillNoTasks = await pool.query(`SELECT count(*)::int AS total FROM ai_tasks WHERE created_by_user_id = $1`, [owner.id]);
  assert.equal(Number(stillNoTasks.rows[0]?.total ?? 0), 0);

  const replay = await request("POST", "/api/v1/try-on", {
    cookie: owner.cookie,
    idempotencyKey: "same-request-1",
    body: {
      personMediaId: person,
      garmentId,
      garmentMediaId: garmentImage,
      garmentPresentation: "catalog",
      consent: { purpose: "try_on_request" },
    },
  });
  assert.equal(replay.status, 201);
  const replayed = await request("POST", "/api/v1/try-on", {
    cookie: owner.cookie,
    idempotencyKey: "same-request-1",
    body: {
      personMediaId: person,
      garmentId,
      garmentMediaId: garmentImage,
      garmentPresentation: "catalog",
      consent: { purpose: "try_on_request" },
    },
  });
  assert.equal(replayed.status, 200);
  assert.equal((replayed.body as { request: TryOn }).request.id, (replay.body as { request: TryOn }).request.id);
  const conflict = await request("POST", "/api/v1/try-on", {
    cookie: owner.cookie,
    idempotencyKey: "same-request-1",
    body: {
      personMediaId: person,
      garmentId,
      garmentMediaId: garmentImage,
      garmentPresentation: "flat_lay",
      consent: { purpose: "try_on_request" },
    },
  });
  assert.equal(conflict.status, 409);

  const cancelled = await request("POST", `/api/v1/try-on/${requestView.id}/cancel`, { cookie: owner.cookie });
  assert.equal(cancelled.status, 200);
  assert.equal((cancelled.body as { request: TryOn }).request.status, "cancelled");
  assert.equal((cancelled.body as { request: TryOn }).request.output, null);
});

test("incompatible garment images and other people's projects are rejected", async () => {
  assert.ok(pool);
  const owner = await register("Maker");
  const stranger = await register("Other");
  const person = await upload(owner.cookie, 256, "person.png");
  const sketch = await upload(owner.cookie, 256, "sketch.png");
  const garmentId = await garmentWithImage(owner.cookie, sketch, "sketch");
  const denied = await submit(owner.cookie, {
    personMediaId: person,
    garmentId,
    garmentMediaId: sketch,
    consent: { purpose: "try_on_request" },
  });
  assert.equal(denied.status, 400);
  assert.equal((denied.body as { error: { code: string } }).error.code, "unsupported_garment");

  const gif = await pool.query<{ id: string }>(
    `INSERT INTO media_assets (
       owner_user_id, media_type, mime_type, byte_size, storage_key, width_px, height_px, status, variant, original_filename
     )
     VALUES ($1, 'image', 'image/gif', 100, $2, 512, 512, 'ready', 'original', 'motion.gif')
     RETURNING id`,
    [owner.id, `originals/${randomUUID()}.gif`],
  );
  const gifId = gif.rows[0]?.id;
  assert.ok(gifId);
  const cloth = await upload(owner.cookie, 256, "cloth.png");
  const clothGarment = await garmentWithImage(owner.cookie, cloth, "front");
  const badType = await submit(owner.cookie, {
    personMediaId: gifId,
    garmentId: clothGarment,
    garmentMediaId: cloth,
    consent: { purpose: "try_on_request" },
  });
  assert.equal(badType.status, 400);

  const huge = await pool.query<{ id: string }>(
    `INSERT INTO media_assets (
       owner_user_id, media_type, mime_type, byte_size, storage_key, width_px, height_px, status, variant, original_filename
     )
     VALUES ($1, 'image', 'image/png', 9000000, $2, 512, 512, 'ready', 'original', 'huge.png')
     RETURNING id`,
    [owner.id, `originals/${randomUUID()}.png`],
  );
  const hugeId = huge.rows[0]?.id;
  assert.ok(hugeId);
  const oversized = await submit(owner.cookie, {
    personMediaId: hugeId,
    garmentId: clothGarment,
    garmentMediaId: cloth,
    consent: { purpose: "try_on_request" },
  });
  assert.equal(oversized.status, 400);

  const project = await request("POST", "/api/v1/design-projects", {
    cookie: stranger.cookie,
    body: { name: "Private project" },
  });
  const projectId = (project.body as { project: { id: string } }).project.id;
  const cross = await submit(owner.cookie, {
    personMediaId: person,
    garmentId: clothGarment,
    garmentMediaId: cloth,
    designProjectId: projectId,
    consent: { purpose: "try_on_request" },
  });
  assert.equal(cross.status, 404);
  const stored = await pool.query(`SELECT count(*)::int AS total FROM try_on_requests WHERE created_by_user_id = $1`, [owner.id]);
  assert.equal(Number(stored.rows[0]?.total ?? 0), 0);
});

async function submit(cookie: string, body: Record<string, unknown>) {
  return request("POST", "/api/v1/try-on", {
    cookie,
    body: { garmentPresentation: "catalog", ...body },
  });
}

async function garmentWithImage(cookie: string, mediaId: string, role: string): Promise<string> {
  const garment = await request("POST", "/api/v1/catalog/garments", {
    cookie,
    body: { name: "Try-on agbada", terms: [{ kind: "garment_type", slug: "agbada" }] },
  });
  assert.equal(garment.status, 201);
  const garmentId = (garment.body as { garment: { id: string } }).garment.id;
  const linked = await request("POST", `/api/v1/catalog/garments/${garmentId}/media`, {
    cookie,
    body: { mediaId, role },
  });
  assert.equal(linked.status, 201);
  return garmentId;
}

async function upload(cookie: string, edge: number, filename: string): Promise<string> {
  const bytes = await sharp({ create: { width: edge, height: edge, channels: 3, background: "#224466" } }).png().toBuffer();
  const response = await fetch(`${baseUrl}/api/v1/media?visibility=private`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-original-filename": filename },
    body: new Uint8Array(bytes),
  });
  const body = (await response.json()) as { media: { id: string } };
  assert.equal(response.status, 201);
  return body.media.id;
}

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  const response = await request("POST", "/api/v1/auth/register", {
    body: { email: `${randomUUID()}@tryon.test`, displayName, password },
  });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, cookie: `bop_session=${token[1]}` };
}

async function request(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; idempotencyKey?: string } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : null };
}

async function removeTryOnFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@tryon.test')`;
  await active.query(`DELETE FROM try_on_requests WHERE created_by_user_id IN ${owners} OR owner_user_id IN ${owners}`);
  await active.query(`DELETE FROM ai_tasks WHERE created_by_user_id IN ${owners} OR owner_user_id IN ${owners}`);
  await active.query(`DELETE FROM design_projects WHERE owner_user_id IN ${owners} OR created_by_user_id IN ${owners}`);
  const garments = `(SELECT id FROM garments WHERE owner_user_id IN ${owners} OR created_by_user_id IN ${owners})`;
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garments WHERE id IN ${garments}`);
  await active.query(`DELETE FROM media_assets WHERE variant = 'thumbnail' AND owner_user_id IN ${owners}`);
  await active.query(`DELETE FROM media_assets WHERE owner_user_id IN ${owners}`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@tryon.test'`);
}
