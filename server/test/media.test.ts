import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import sharp from "sharp";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool, withTransaction } from "../src/db/pool";
import { sanitizeFilename } from "../src/modules/images";
import { createOrganization } from "../src/modules/organizations";
import { assertMediaRoot, localMediaStorage, withStoredFiles, type MediaStorage } from "../src/modules/storage";

const password = "media-pass-1";
const storageDir = path.resolve(".local/media-test");
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Media = {
  id: string;
  mimeType: string;
  visibility: string;
  access: string;
  originalFilename: string;
  thumbnailId: string | null;
  widthPx: number | null;
  status: string;
  variant: string;
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so media tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so media tests were not executed.");
  await migrate(pool);
  await removeMediaFixtures(pool);
  await rm(storageDir, { recursive: true, force: true });
  server = createApp({ storage: localStorage() }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeMediaFixtures(pool);
  await rm(storageDir, { recursive: true, force: true });
  await closePool();
});

test("storage stays outside the public site and unsafe names are reduced to a file name", () => {
  assert.throws(() => assertMediaRoot(path.resolve("public")), /public directory/);
  assert.equal(sanitizeFilename("..\\..\\secret.png"), "secret.png");
  assert.equal(sanitizeFilename("../../secret.png").includes(".."), false);
});

test("a failed database write removes stored files", async () => {
  const storage = new MemoryStorage();
  await assert.rejects(
    () => withStoredFiles(storage, [{ key: "originals/example.png", bytes: Buffer.from("image") }], async () => {
      throw new Error("insert failed");
    }),
    /insert failed/,
  );
  assert.equal(storage.files.size, 0);
});

test("a valid image is stored from its bytes, and a forged type is rejected", async () => {
  const owner = await register("Owner");
  const stranger = await register("Stranger");
  const bytes = await sharp({
    create: { width: 640, height: 400, channels: 3, background: { r: 12, g: 40, b: 70 } },
  })
    .png()
    .toBuffer();
  const uploaded = await sendImage(owner.cookie, bytes, {
    headers: { "content-type": "text/plain", "x-original-filename": "..\\..\\secret.png" },
  });
  assert.equal(uploaded.status, 201);
  const media = (uploaded.body as { media: Media }).media;
  assert.equal(media.mimeType, "image/png");
  assert.equal(media.status, "ready");
  assert.equal(media.visibility, "private");
  assert.equal(media.originalFilename, "secret.png");
  assert.equal(media.widthPx, 640);
  assert.ok(media.thumbnailId);
  assert.equal(JSON.stringify(uploaded.body).includes("storageKey"), false);
  assert.equal(JSON.stringify(uploaded.body).includes(storageDir), false);

  const content = await fetch(`${baseUrl}/api/v1/media/${media.id}/content`, { headers: { cookie: owner.cookie } });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);

  const preview = await fetch(`${baseUrl}/api/v1/media/${media.thumbnailId}/content`, {
    headers: { cookie: owner.cookie },
  });
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  const previewMeta = await sharp(previewBytes).metadata();
  assert.equal(preview.status, 200);
  assert.ok((previewMeta.width ?? 0) <= 480);
  assert.notEqual(previewBytes.length, bytes.length);

  const hidden = await fetch(`${baseUrl}/api/v1/media/${media.id}/content`);
  assert.equal(hidden.status, 404);
  const other = await fetch(`${baseUrl}/api/v1/media/${media.id}`, { headers: { cookie: stranger.cookie } });
  assert.equal(other.status, 404);

  const forged = await sendImage(owner.cookie, Buffer.from("this is not a png"), {
    headers: { "content-type": "image/png" },
  });
  assert.equal(forged.status, 400);
  assert.equal((forged.body as { error: { code: string } }).error.code, "invalid_image");

  const gif = await sendImage(owner.cookie, Buffer.from("GIF89a"));
  assert.equal(gif.status, 400);
});

test("public media can be read, and deletion removes the file", async () => {
  const owner = await register("Publisher");
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#224466" } }).jpeg().toBuffer();
  const uploaded = await sendImage(owner.cookie, bytes, { query: "?visibility=public" });
  const media = (uploaded.body as { media: Media }).media;
  const anonymous = await fetch(`${baseUrl}/api/v1/media/${media.id}/content`);
  assert.equal(anonymous.status, 200);

  const removed = await fetch(`${baseUrl}/api/v1/media/${media.id}`, {
    method: "DELETE",
    headers: { cookie: owner.cookie },
  });
  assert.equal(removed.status, 204);
  const again = await fetch(`${baseUrl}/api/v1/media/${media.id}/content`);
  assert.equal(again.status, 404);
  assert.ok(pool);
  const rows = await pool.query(`SELECT id FROM media_assets WHERE id = $1`, [media.id]);
  assert.equal(rows.rowCount, 0);
});

test("organization media stays inside that organization and can be linked to a garment", async () => {
  assert.ok(pool);
  const tailor = await register("Tailor");
  const stranger = await register("Visitor");
  const slug = `media-test-${randomUUID().slice(0, 8)}`;
  const organization = await withTransaction((client) =>
    createOrganization(client, tailor.id, { name: "Media House", slug, kind: "tailor" }),
  );
  const garment = await request("POST", "/api/v1/catalog/garments", {
    cookie: tailor.cookie,
    body: { name: "Reference cloth", organizationId: organization.id },
  });
  assert.equal(garment.status, 201);
  const garmentId = (garment.body as { garment: { id: string } }).garment.id;
  const bytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#663311" } }).png().toBuffer();
  const uploaded = await sendImage(tailor.cookie, bytes, {
    query: `?organizationId=${organization.id}&garmentId=${garmentId}&role=fabric`,
  });
  assert.equal(uploaded.status, 201);
  const mediaId = (uploaded.body as { media: Media }).media.id;
  const denied = await fetch(`${baseUrl}/api/v1/media/${mediaId}/content`, { headers: { cookie: stranger.cookie } });
  assert.equal(denied.status, 404);
  const seen = await request("GET", `/api/v1/catalog/garments/${garmentId}`, { cookie: tailor.cookie });
  const linked = seen.body as { garment: { media: { role: string }[] } };
  assert.equal(linked.garment.media[0]?.role, "fabric");
});

test("a missing garment does not leave an uploaded file behind", async () => {
  const storage = new MemoryStorage();
  const local = await listen(createApp({ storage }));
  try {
    const owner = await register("Cleaner", local.url);
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#000" } }).png().toBuffer();
    const response = await sendImage(owner.cookie, bytes, { query: `?garmentId=${randomUUID()}`, url: local.url });
    assert.equal(response.status, 404);
    assert.equal(storage.files.size, 0);
  } finally {
    await local.close();
  }
});

test("oversized files, huge dimensions, and repeated uploads are rejected", async () => {
  const tiny = await listen(createApp({ storage: new MemoryStorage(), maxMediaBytes: 32 }));
  const narrow = await listen(createApp({ storage: new MemoryStorage(), maxMediaEdge: 8 }));
  const limited = await listen(createApp({ storage: new MemoryStorage(), maxUploadsPerMinute: 1 }));
  try {
    const maker = await register("Limiter", tiny.url);
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#abcdef" } }).png().toBuffer();
    const tooBig = await sendImage(maker.cookie, bytes, { url: tiny.url });
    assert.equal(tooBig.status, 413);
    const tooWide = await sendImage(maker.cookie, bytes, { url: narrow.url });
    assert.equal(tooWide.status, 400);
    assert.equal((tooWide.body as { error: { code: string } }).error.code, "image_too_large");
    const first = await sendImage(maker.cookie, bytes, { url: limited.url });
    const second = await sendImage(maker.cookie, bytes, { url: limited.url });
    assert.equal(first.status, 201);
    assert.equal(second.status, 429);
  } finally {
    await tiny.close();
    await narrow.close();
    await limited.close();
  }
});

function localStorage(): MediaStorage {
  return localMediaStorage(storageDir);
}

class MemoryStorage implements MediaStorage {
  files = new Map<string, Buffer>();

  async write(key: string, bytes: Buffer) {
    if (this.files.has(key)) throw new Error("exists");
    this.files.set(key, Buffer.from(bytes));
  }

  async read(key: string) {
    const found = this.files.get(key);
    if (!found) throw new Error("missing");
    return Buffer.from(found);
  }

  async remove(key: string) {
    this.files.delete(key);
  }
}

async function listen(app: ReturnType<typeof createApp>) {
  const started = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => started.once("listening", () => resolve()));
  return {
    url: `http://127.0.0.1:${(started.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => started.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function register(displayName: string, url = baseUrl): Promise<{ id: string; cookie: string }> {
  const response = await request("POST", "/api/v1/auth/register", {
    url,
    body: { email: `${randomUUID()}@media.test`, displayName, password },
  });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, cookie: `bop_session=${token[1]}` };
}

async function request(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; url?: string } = {},
) {
  const response = await fetch(`${options.url ?? baseUrl}${path}`, {
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

async function sendImage(
  cookie: string,
  bytes: Buffer,
  options: { query?: string; headers?: Record<string, string>; url?: string } = {},
) {
  const response = await fetch(`${options.url ?? baseUrl}/api/v1/media${options.query ?? ""}`, {
    method: "POST",
    headers: { cookie, ...options.headers },
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

async function removeMediaFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@media.test')`;
  const orgs = `(SELECT id FROM organizations WHERE slug LIKE 'media-test-%')`;
  const garments = `(SELECT id FROM garments WHERE owner_user_id IN ${owners} OR created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`;
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN ${garments} OR media_id IN (SELECT id FROM media_assets WHERE owner_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garments WHERE id IN ${garments}`);
  await active.query(`DELETE FROM media_assets WHERE variant = 'thumbnail' AND (owner_user_id IN ${owners} OR owner_organization_id IN ${orgs})`);
  await active.query(`DELETE FROM media_assets WHERE owner_user_id IN ${owners} OR owner_organization_id IN ${orgs}`);
  await active.query(`DELETE FROM organization_memberships WHERE user_id IN ${owners} OR organization_id IN ${orgs}`);
  await active.query(`DELETE FROM organizations WHERE slug LIKE 'media-test-%'`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@media.test'`);
}
