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
import { readConfig } from "../src/config";
import { migrate } from "../src/db/migrate";
import { closePool, getPool } from "../src/db/pool";
import { resolveAiSettings, type AiSettings } from "../src/modules/ai-settings";
import { runWorkerOnce } from "../src/modules/ai-worker";
import { localMediaStorage } from "../src/modules/storage";

const password = "analysis-pass-1";
const storageDir = path.resolve(".local/media-analysis-test");
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";
let ai: AiSettings;

type Attribute = {
  key: string;
  value: string | number | string[] | null;
  basis: string;
  note: string;
  confidence: number | null;
  confidenceSource: string | null;
  reviewStatus: string;
  fiberEstablished: boolean;
};

type Analysis = {
  id: string;
  taskId: string;
  status: string;
  simulated: boolean;
  operational: boolean;
  schemaVersion: string;
  providerId: string;
  modelId: string | null;
  summary: string | null;
  error: { category: string; message: string } | null;
  attributes: Attribute[];
  applications: { applied: { slug: string }[]; skipped: { key: string; reason: string }[] }[];
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so analysis tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so analysis tests were not executed.");
  await migrate(pool);
  await removeAnalysisFixtures(pool);
  await rm(storageDir, { recursive: true, force: true });
  ai = resolveAiSettings(readConfig(), {
    testProvider: true,
    maxAttempts: 3,
    timeoutMs: 40,
    backoffMs: 0,
    staleRunningMs: 60_000,
  });
  server = createApp({ storage: localMediaStorage(storageDir), ai }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeAnalysisFixtures(pool);
  await rm(storageDir, { recursive: true, force: true });
  await closePool();
});

test("a missing provider rejects analysis and an external image URL is not fetched", async () => {
  const quiet = resolveAiSettings(readConfig(), { testProvider: false });
  const quietServer = createApp({ storage: localMediaStorage(storageDir), ai: quiet }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => quietServer.once("listening", () => resolve()));
  const quietUrl = `http://127.0.0.1:${(quietServer.address() as AddressInfo).port}`;
  try {
    const owner = await registerOn(quietUrl, "Quiet analyst");
    const imageId = await uploadOn(quietUrl, owner.cookie);
    const capabilities = await requestOn(quietUrl, "GET", "/api/v1/ai/capabilities", { cookie: owner.cookie });
    const extraction = (capabilities.body as { capabilities: { id: string; configured: boolean; operational: boolean; simulated: boolean }[] }).capabilities.find(
      (item) => item.id === "fashion.garment_attribute_extraction",
    );
    assert.equal(extraction?.configured, false);
    assert.equal(extraction?.operational, false);
    assert.equal(extraction?.simulated, false);
    const denied = await requestOn(quietUrl, "POST", "/api/v1/analyses", {
      cookie: owner.cookie,
      body: { mediaId: imageId },
    });
    assert.equal(denied.status, 400);
    assert.equal((denied.body as { error: { code: string } }).error.code, "capability_unavailable");
    const listed = await requestOn(quietUrl, "GET", "/api/v1/analyses", { cookie: owner.cookie });
    assert.equal((listed.body as { page: { total: number } }).page.total, 0);
    const remote = await requestOn(quietUrl, "POST", "/api/v1/analyses", {
      cookie: owner.cookie,
      body: { mediaId: imageId, url: "http://127.0.0.1/secret.png" },
    });
    assert.equal(remote.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => quietServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test("simulated analysis stays unknown until a person reviews it, and catalog data is not overwritten", async () => {
  assert.ok(pool);
  const owner = await register("Analyst");
  const stranger = await register("Stranger");
  const anonymous = await request("POST", "/api/v1/analyses", { body: { mediaId: randomUUID() } });
  assert.equal(anonymous.status, 401);
  const missing = await request("GET", `/api/v1/analyses/${randomUUID()}`, { cookie: owner.cookie });
  assert.equal(missing.status, 404);

  const foreign = await uploadPng(stranger.cookie);
  const hiddenMedia = await request("POST", "/api/v1/analyses", { cookie: owner.cookie, body: { mediaId: foreign } });
  assert.equal(hiddenMedia.status, 404);

  const imageId = await uploadPng(owner.cookie);
  const queued = await request("POST", "/api/v1/analyses", {
    cookie: owner.cookie,
    body: { mediaId: imageId, outcome: "succeed" },
  });
  assert.equal(queued.status, 202);
  const created = (queued.body as { analysis: Analysis }).analysis;
  assert.equal(created.status, "queued");
  assert.equal(created.simulated, true);
  assert.equal(created.operational, false);
  assert.equal(JSON.stringify(queued.body).includes("storageKey"), false);
  const strangerRead = await request("GET", `/api/v1/analyses/${created.id}`, { cookie: stranger.cookie });
  assert.equal(strangerRead.status, 404);

  const ran = await runWorkerOnce(pool, ai);
  assert.equal(ran.taskId, created.taskId);
  const finished = (await request("GET", `/api/v1/analyses/${created.id}`, { cookie: owner.cookie })).body as {
    analysis: Analysis;
  };
  assert.equal(finished.analysis.status, "succeeded");
  assert.equal(finished.analysis.schemaVersion, "garment-attributes.v1");
  assert.equal(finished.analysis.providerId, "test");
  assert.equal(finished.analysis.modelId, null);
  assert.equal(finished.analysis.summary?.includes("No model was called"), true);
  const material = finished.analysis.attributes.find((item) => item.key === "apparent_material");
  assert.equal(material?.basis, "unknown");
  assert.equal(material?.value, null);
  assert.equal(material?.confidence, null);
  assert.equal(material?.fiberEstablished, false);
  const acceptedUnknown = await request("PATCH", `/api/v1/analyses/${created.id}/attributes/apparent_material`, {
    cookie: owner.cookie,
    body: { decision: "accept" },
  });
  assert.equal(acceptedUnknown.status, 400);

  const garment = await request("POST", "/api/v1/catalog/garments", {
    cookie: owner.cookie,
    body: { name: "Existing shirt", terms: [{ kind: "garment_type", slug: "shirt" }, { kind: "material", slug: "cotton" }] },
  });
  const garmentId = (garment.body as { garment: { id: string; terms: { kind: string; slug: string }[] } }).garment.id;
  const corrected = await request("PATCH", `/api/v1/analyses/${created.id}/attributes/primary_type`, {
    cookie: owner.cookie,
    body: { decision: "correct", value: "agbada", basis: "inferred", note: "Reviewed by the owner." },
  });
  assert.equal(corrected.status, 200);
  const fiber = await request("PATCH", `/api/v1/analyses/${created.id}/attributes/apparent_material`, {
    cookie: owner.cookie,
    body: { decision: "correct", value: "silk", basis: "observed", note: "Looks shiny." },
  });
  assert.equal(fiber.status, 400);
  const kept = await request("POST", `/api/v1/analyses/${created.id}/apply`, {
    cookie: owner.cookie,
    body: { garmentId },
  });
  assert.equal(kept.status, 200);
  const unchanged = await request("GET", `/api/v1/catalog/garments/${garmentId}`, { cookie: owner.cookie });
  const terms = (unchanged.body as { garment: { terms: { kind: string; slug: string }[] } }).garment.terms;
  assert.equal(terms.some((term) => term.kind === "garment_type" && term.slug === "shirt"), true);
  assert.equal(terms.some((term) => term.slug === "silk"), false);
  const replaced = await request("POST", `/api/v1/analyses/${created.id}/apply`, {
    cookie: owner.cookie,
    body: { garmentId, replaceKinds: ["garment_type"] },
  });
  assert.equal(replaced.status, 200);
  const updated = await request("GET", `/api/v1/catalog/garments/${garmentId}`, { cookie: owner.cookie });
  const nextTerms = (updated.body as { garment: { terms: { kind: string; slug: string }[] } }).garment.terms;
  assert.equal(nextTerms.some((term) => term.kind === "garment_type" && term.slug === "agbada"), true);
  assert.equal(nextTerms.some((term) => term.kind === "material" && term.slug === "cotton"), true);
  const outsiderGarment = await request("POST", "/api/v1/catalog/garments", { cookie: stranger.cookie, body: { name: "Private" } });
  const outsiderId = (outsiderGarment.body as { garment: { id: string } }).garment.id;
  const blocked = await request("POST", `/api/v1/analyses/${created.id}/apply`, {
    cookie: owner.cookie,
    body: { garmentId: outsiderId, replaceKinds: ["garment_type"] },
  });
  assert.equal(blocked.status, 404);
});

test("provider fixtures cover partial, invalid, failed, timed out, and cancelled analysis", async () => {
  assert.ok(pool);
  const owner = await register("Fixtures");
  const imageId = await uploadPng(owner.cookie);
  const partial = await finish(owner.cookie, imageId, "partial");
  assert.equal(partial.status, "succeeded");
  assert.equal(partial.attributes.find((item) => item.key === "primary_type")?.basis, "unknown");
  assert.equal(partial.attributes.find((item) => item.key === "pattern")?.confidence, null);

  const fixture = await finish(owner.cookie, imageId, "fixture");
  assert.equal(fixture.attributes.find((item) => item.key === "primary_type")?.value, "agbada");
  assert.equal(fixture.attributes.find((item) => item.key === "apparent_material")?.basis, "unknown");
  assert.equal(fixture.attributes.find((item) => item.key === "tradition")?.basis, "unknown");
  assert.equal(fixture.simulated, true);

  const malformed = await finish(owner.cookie, imageId, "malformed");
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.error?.category, "invalid_response");
  assert.equal(malformed.attributes.length, 0);

  const invalidType = await finish(owner.cookie, imageId, "invalid_type");
  assert.equal(invalidType.status, "failed");
  assert.equal(invalidType.error?.category, "invalid_response");

  const failed = await finish(owner.cookie, imageId, "permanent_failure");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.category, "permanent");

  const timedOut = await finish(owner.cookie, imageId, "timeout");
  assert.equal(timedOut.error?.category, "timeout");
  assert.equal(timedOut.status, "failed");

  const hanging = await request("POST", "/api/v1/analyses", {
    cookie: owner.cookie,
    body: { mediaId: imageId, outcome: "hang" },
  });
  const hangingId = (hanging.body as { analysis: Analysis }).analysis.id;
  await runWorkerOnce(pool, ai);
  const hung = (await request("GET", `/api/v1/analyses/${hangingId}`, { cookie: owner.cookie })).body as { analysis: Analysis };
  assert.equal(hung.analysis.error?.message, "The attempt timed out.");
  await runWorkerOnce(pool, ai);
  await runWorkerOnce(pool, ai);

  const open = await request("POST", "/api/v1/analyses", {
    cookie: owner.cookie,
    body: { mediaId: imageId, outcome: "succeed" },
  });
  const openId = (open.body as { analysis: Analysis }).analysis.id;
  const cancelled = await request("POST", `/api/v1/analyses/${openId}/cancel`, { cookie: owner.cookie });
  assert.equal((cancelled.body as { analysis: Analysis }).analysis.status, "cancelled");
  const skipped = await runWorkerOnce(pool, ai);
  assert.equal(skipped.taskId, null);
});

async function finish(cookie: string, mediaId: string, outcome: string): Promise<Analysis> {
  assert.ok(pool);
  const created = await request("POST", "/api/v1/analyses", { cookie, body: { mediaId, outcome } });
  assert.equal(created.status, 202);
  const analysis = (created.body as { analysis: Analysis }).analysis;
  const attempts = outcome === "timeout" ? 3 : 1;
  for (let index = 0; index < attempts; index += 1) {
    const ran = await runWorkerOnce(pool, ai);
    if (outcome !== "timeout" || index === 0) assert.equal(ran.taskId, analysis.taskId);
  }
  const loaded = await request("GET", `/api/v1/analyses/${analysis.id}`, { cookie });
  return (loaded.body as { analysis: Analysis }).analysis;
}

async function uploadPng(cookie: string): Promise<string> {
  return uploadOn(baseUrl, cookie);
}

async function uploadOn(url: string, cookie: string): Promise<string> {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#224466" } }).png().toBuffer();
  const response = await fetch(`${url}/api/v1/media?visibility=private`, {
    method: "POST",
    headers: { cookie, "content-type": "application/octet-stream", "x-original-filename": "reference.png" },
    body: new Uint8Array(bytes),
  });
  const body = (await response.json()) as { media: { id: string } };
  assert.equal(response.status, 201);
  return body.media.id;
}

async function register(displayName: string) {
  return registerOn(baseUrl, displayName);
}

async function registerOn(url: string, displayName: string) {
  const response = await requestOn(url, "POST", "/api/v1/auth/register", {
    body: { email: `${randomUUID()}@analysis.test`, displayName, password },
  });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, cookie: `bop_session=${token[1]}` };
}

async function request(method: string, path: string, options: { cookie?: string; body?: unknown } = {}) {
  return requestOn(baseUrl, method, path, options);
}

async function requestOn(url: string, method: string, path: string, options: { cookie?: string; body?: unknown } = {}) {
  const response = await fetch(`${url}${path}`, {
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

async function removeAnalysisFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@analysis.test')`;
  const orgs = `(SELECT id FROM organizations WHERE slug LIKE 'analysis-test-%')`;
  await active.query(
    `DELETE FROM ai_tasks
     WHERE owner_user_id IN ${owners}
        OR created_by_user_id IN ${owners}
        OR owner_organization_id IN ${orgs}`,
  );
  const garments = `(SELECT id FROM garments WHERE owner_user_id IN ${owners} OR created_by_user_id IN ${owners} OR owner_organization_id IN ${orgs})`;
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN ${garments}`);
  await active.query(`DELETE FROM garments WHERE id IN ${garments}`);
  await active.query(
    `DELETE FROM media_assets WHERE variant = 'thumbnail' AND (owner_user_id IN ${owners} OR owner_organization_id IN ${orgs})`,
  );
  await active.query(`DELETE FROM media_assets WHERE owner_user_id IN ${owners} OR owner_organization_id IN ${orgs}`);
  await active.query(`DELETE FROM organization_memberships WHERE user_id IN ${owners} OR organization_id IN ${orgs}`);
  await active.query(`DELETE FROM organizations WHERE slug LIKE 'analysis-test-%'`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@analysis.test'`);
}
