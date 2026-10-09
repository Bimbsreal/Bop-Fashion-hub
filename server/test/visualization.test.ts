import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool, withTransaction } from "../src/db/pool";
import { addMember, createOrganization } from "../src/modules/organizations";

const password = "visualize-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Concept = {
  id: string;
  title: string;
  notes: string;
  status: string;
  method: string;
  access: string;
  generated: boolean;
  referenceCount: number;
  preview: { mediaId: string; origin: string; available: boolean } | null;
  references: { mediaId: string; position: number; origin: string; available: boolean; filename: string | null }[];
  designProject: { id: string; name?: string; available?: boolean } | null;
  revision: { id: string; revisionNumber?: number; available?: boolean } | null;
  garment: { id: string; name?: string; available?: boolean; terms?: { slug: string }[] } | null;
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so visualization tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so visualization tests were not executed.");
  await migrate(pool);
  await removeVisualizationFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeVisualizationFixtures(pool);
  await closePool();
});

test("a private concept is visible only to its owner and does not accept an external image", async () => {
  const owner = await register("Owner");
  const stranger = await register("Stranger");
  const created = await request("POST", "/api/v1/visualizations", {
    cookie: owner.cookie,
    body: { title: "Agbada study", notes: "Indigo and gold references", method: "reference_board" },
  });
  assert.equal(created.status, 201);
  const concept = (created.body as { concept: Concept }).concept;
  assert.equal(concept.status, "draft");
  assert.equal(concept.generated, false);
  assert.equal(concept.referenceCount, 0);
  assert.equal(concept.preview, null);
  assert.equal(JSON.stringify(created.body).includes("storageKey"), false);

  const hidden = await request("GET", `/api/v1/visualizations/${concept.id}`, { cookie: stranger.cookie });
  assert.equal(hidden.status, 404);
  const missing = await request("GET", `/api/v1/visualizations/${randomUUID()}`, { cookie: owner.cookie });
  assert.equal(missing.status, 404);
  const anonymous = await request("POST", "/api/v1/visualizations", { body: { title: "Nope" } });
  assert.equal(anonymous.status, 401);
  const blank = await request("POST", "/api/v1/visualizations", { cookie: owner.cookie, body: { title: "  " } });
  assert.equal(blank.status, 400);
  const external = await request("POST", "/api/v1/visualizations", {
    cookie: owner.cookie,
    body: { title: "Remote", url: "http://example.test/look.png" },
  });
  assert.equal(external.status, 400);
  assert.equal((external.body as { error: { code: string } }).error.code, "invalid_body");

  const notes = await request("PATCH", `/api/v1/visualizations/${concept.id}`, {
    cookie: owner.cookie,
    body: { notes: "Keep the sleeve full." },
  });
  assert.equal(notes.status, 200);
  assert.equal((notes.body as { concept: Concept }).concept.notes, "Keep the sleeve full.");
  const statusOnPatch = await request("PATCH", `/api/v1/visualizations/${concept.id}`, {
    cookie: owner.cookie,
    body: { status: "archived" },
  });
  assert.equal(statusOnPatch.status, 400);

  const published = await request("PATCH", `/api/v1/visualizations/${concept.id}`, {
    cookie: owner.cookie,
    body: { visibility: "public" },
  });
  assert.equal(published.status, 200);
  const open = await request("GET", `/api/v1/visualizations/${concept.id}`);
  assert.equal(open.status, 200);
  assert.equal((open.body as { concept: Concept }).concept.access, "view");
  const anonymousWrite = await request("PATCH", `/api/v1/visualizations/${concept.id}`, { body: { title: "Taken" } });
  assert.equal(anonymousWrite.status, 401);
  const listed = await request("GET", "/api/v1/visualizations", { cookie: stranger.cookie });
  assert.equal((listed.body as { concepts: { id: string }[] }).concepts.some((item) => item.id === concept.id), true);
});

test("references can be ordered and removed without deleting the media asset", async () => {
  assert.ok(pool);
  const owner = await register("Board");
  const other = await register("Other");
  const created = await request("POST", "/api/v1/visualizations", {
    cookie: owner.cookie,
    body: { title: "Reference board" },
  });
  const conceptId = (created.body as { concept: Concept }).concept.id;
  const foreign = await attachMedia(other, "foreign.png");
  const denied = await request("POST", `/api/v1/visualizations/${conceptId}/references`, {
    cookie: owner.cookie,
    body: { mediaId: foreign.id, origin: "original_reference" },
  });
  assert.equal(denied.status, 404);
  const stillEmpty = await request("GET", `/api/v1/visualizations/${conceptId}`, { cookie: owner.cookie });
  assert.equal((stillEmpty.body as { concept: Concept }).concept.referenceCount, 0);

  const first = await attachMedia(owner, "first.png");
  const second = await attachMedia(owner, "second.png");
  const added = await request("POST", `/api/v1/visualizations/${conceptId}/references`, {
    cookie: owner.cookie,
    body: { mediaId: first.id, origin: "original_reference", note: "Cloth study" },
  });
  assert.equal(added.status, 201);
  const withFirst = (added.body as { concept: Concept }).concept;
  assert.equal(withFirst.generated, false);
  assert.equal(withFirst.preview?.mediaId, first.id);
  assert.equal(withFirst.preview?.origin, "original_reference");
  assert.equal(withFirst.references[0]?.origin, "original_reference");

  const duplicate = await request("POST", `/api/v1/visualizations/${conceptId}/references`, {
    cookie: owner.cookie,
    body: { mediaId: first.id, origin: "manual_upload" },
  });
  assert.equal(duplicate.status, 409);
  await request("POST", `/api/v1/visualizations/${conceptId}/references`, {
    cookie: owner.cookie,
    body: { mediaId: second.id, origin: "manual_upload" },
  });
  const ordered = await request("POST", `/api/v1/visualizations/${conceptId}/references/order`, {
    cookie: owner.cookie,
    body: { mediaIds: [second.id, first.id] },
  });
  assert.equal(ordered.status, 200);
  const positions = (ordered.body as { concept: Concept }).concept.references;
  assert.deepEqual(positions.map((item) => item.mediaId), [second.id, first.id]);
  assert.deepEqual(positions.map((item) => item.position), [1, 2]);
  assert.equal(positions[0]?.origin, "manual_upload");

  const thumbnail = await pool.query<{ id: string }>(
    `INSERT INTO media_assets (
       owner_user_id, media_type, mime_type, byte_size, storage_key, status, variant, derivative_of_id, original_filename
     )
     VALUES ($1, 'image', 'image/png', 8, $2, 'ready', 'thumbnail', $3, 'thumb.png')
     RETURNING id`,
    [owner.id, `thumbnails/${randomUUID()}.png`, first.id],
  );
  const thumbnailDenied = await request("POST", `/api/v1/visualizations/${conceptId}/references`, {
    cookie: owner.cookie,
    body: { mediaId: thumbnail.rows[0]?.id, origin: "original_reference" },
  });
  assert.equal(thumbnailDenied.status, 400);

  const removed = await request("DELETE", `/api/v1/visualizations/${conceptId}/references/${second.id}`, {
    cookie: owner.cookie,
  });
  assert.equal(removed.status, 200);
  const remaining = (removed.body as { concept: Concept }).concept;
  assert.equal(remaining.references.length, 1);
  assert.equal(remaining.references[0]?.mediaId, first.id);
  assert.equal(remaining.preview?.mediaId, first.id);
  const mediaStillThere = await pool.query(`SELECT id FROM media_assets WHERE id = $1`, [second.id]);
  assert.equal(mediaStillThere.rowCount, 1);

  const generated = await request("POST", `/api/v1/visualizations/${conceptId}/generate`, {
    cookie: owner.cookie,
    body: {},
  });
  assert.equal(generated.status, 400);
  assert.equal((generated.body as { error: { code: string } }).error.code, "capability_unavailable");
  const after = await request("GET", `/api/v1/visualizations/${conceptId}`, { cookie: owner.cookie });
  const afterConcept = (after.body as { concept: Concept }).concept;
  assert.equal(afterConcept.generated, false);
  assert.equal(afterConcept.preview?.origin, "original_reference");
  assert.equal(afterConcept.references.length, 1);
  const tasks = await pool.query(
    `SELECT count(*)::int AS total FROM ai_tasks WHERE created_by_user_id = $1`,
    [owner.id],
  );
  assert.equal(Number(tasks.rows[0]?.total ?? 0), 0);
  const mediaCount = await pool.query(
    `SELECT count(*)::int AS total FROM media_assets WHERE owner_user_id = $1 AND variant = 'original'`,
    [owner.id],
  );
  assert.equal(Number(mediaCount.rows[0]?.total ?? 0), 2);
});

test("garment, project, and revision links stay inside what the caller can read", async () => {
  assert.ok(pool);
  const owner = await register("Studio owner");
  const member = await register("Studio member");
  const stranger = await register("Outsider");
  const slug = `visualize-test-${randomUUID().slice(0, 8)}`;
  const organization = await withTransaction((client) =>
    createOrganization(client, owner.id, { name: "Preview Studio", slug, kind: "studio" }),
  );
  await withTransaction((client) =>
    addMember(client, owner.id, { organizationId: organization.id, userId: member.id, role: "member" }),
  );
  const created = await request("POST", "/api/v1/visualizations", {
    cookie: owner.cookie,
    body: { title: "House preview", organizationId: organization.id, method: "concept_preview" },
  });
  assert.equal(created.status, 201);
  const conceptId = (created.body as { concept: Concept }).concept.id;
  assert.equal((created.body as { concept: Concept }).concept.access, "manage");

  const outsider = await request("GET", `/api/v1/visualizations/${conceptId}`, { cookie: stranger.cookie });
  assert.equal(outsider.status, 404);
  const memberEdit = await request("PATCH", `/api/v1/visualizations/${conceptId}`, {
    cookie: member.cookie,
    body: { notes: "Member arrangement" },
  });
  assert.equal(memberEdit.status, 200);
  const memberArchive = await request("POST", `/api/v1/visualizations/${conceptId}/status`, {
    cookie: member.cookie,
    body: { status: "archived" },
  });
  assert.equal(memberArchive.status, 403);

  const foreignGarment = await request("POST", "/api/v1/catalog/garments", {
    cookie: stranger.cookie,
    body: { name: "Private agbada" },
  });
  const foreignGarmentId = (foreignGarment.body as { garment: { id: string } }).garment.id;
  const deniedGarment = await request("PATCH", `/api/v1/visualizations/${conceptId}`, {
    cookie: owner.cookie,
    body: { garmentId: foreignGarmentId },
  });
  assert.equal(deniedGarment.status, 404);

  const garment = await request("POST", "/api/v1/catalog/garments", {
    cookie: owner.cookie,
    body: { name: "Studio agbada", organizationId: organization.id, terms: [{ kind: "garment_type", slug: "agbada" }] },
  });
  const garmentId = (garment.body as { garment: { id: string } }).garment.id;
  const linkedGarment = await request("PATCH", `/api/v1/visualizations/${conceptId}`, {
    cookie: member.cookie,
    body: { garmentId },
  });
  assert.equal(linkedGarment.status, 200);
  assert.equal((linkedGarment.body as { concept: Concept }).concept.garment?.name, "Studio agbada");

  const foreignProject = await request("POST", "/api/v1/design-projects", {
    cookie: stranger.cookie,
    body: { name: "Private project" },
  });
  const foreignProjectId = (foreignProject.body as { project: { id: string } }).project.id;
  const deniedProject = await request("PATCH", `/api/v1/visualizations/${conceptId}`, {
    cookie: owner.cookie,
    body: { designProjectId: foreignProjectId },
  });
  assert.equal(deniedProject.status, 404);

  const project = await request("POST", "/api/v1/design-projects", {
    cookie: owner.cookie,
    body: { name: "Sleeve project", organizationId: organization.id },
  });
  const projectId = (project.body as { project: { id: string } }).project.id;
  const otherProject = await request("POST", "/api/v1/design-projects", {
    cookie: owner.cookie,
    body: { name: "Other project", organizationId: organization.id },
  });
  const otherProjectId = (otherProject.body as { project: { id: string } }).project.id;
  const otherRevision = await request("POST", `/api/v1/design-projects/${otherProjectId}/revisions`, {
    cookie: owner.cookie,
    body: { note: "Not this board" },
  });
  const otherRevisionId = (otherRevision.body as { revision: { id: string } }).revision.id;
  const linkedProject = await request("PATCH", `/api/v1/visualizations/${conceptId}`, {
    cookie: member.cookie,
    body: { designProjectId: projectId },
  });
  assert.equal(linkedProject.status, 200);
  assert.equal((linkedProject.body as { concept: Concept }).concept.designProject?.name, "Sleeve project");
  const wrongRevision = await request("PATCH", `/api/v1/visualizations/${conceptId}`, {
    cookie: owner.cookie,
    body: { revisionId: otherRevisionId },
  });
  assert.equal(wrongRevision.status, 400);
  const ownRevision = await request("POST", `/api/v1/design-projects/${projectId}/revisions`, {
    cookie: owner.cookie,
    body: { note: "Full sleeve" },
  });
  const revisionId = (ownRevision.body as { revision: { id: string } }).revision.id;
  const linkedRevision = await request("PATCH", `/api/v1/visualizations/${conceptId}`, {
    cookie: owner.cookie,
    body: { revisionId },
  });
  assert.equal(linkedRevision.status, 200);
  assert.equal((linkedRevision.body as { concept: Concept }).concept.revision?.revisionNumber, 2);

  const tasks = await request("POST", "/api/v1/ai/tasks", {
    cookie: owner.cookie,
    body: { capability: "fashion.design_visualization", designProjectId: projectId, note: "Generate a preview" },
  });
  assert.equal(tasks.status, 400);
  assert.equal((tasks.body as { error: { code: string } }).error.code, "capability_unavailable");
  const taskList = await request("GET", "/api/v1/ai/tasks", { cookie: owner.cookie });
  assert.equal((taskList.body as { page: { total: number } }).page.total, 0);
});

async function attachMedia(user: { cookie: string }, filename: string): Promise<{ id: string }> {
  const garment = await request("POST", "/api/v1/catalog/garments", {
    cookie: user.cookie,
    body: { name: filename },
  });
  const garmentId = (garment.body as { garment: { id: string } }).garment.id;
  const media = await request("POST", `/api/v1/catalog/garments/${garmentId}/media`, {
    cookie: user.cookie,
    body: {
      role: "reference",
      mediaType: "image",
      mimeType: "image/png",
      byteSize: 16,
      storageKey: `visualize/${randomUUID()}.png`,
      originalFilename: filename,
    },
  });
  const id = (media.body as { garment: { media: { id: string }[] } }).garment.media[0]?.id;
  assert.ok(id);
  return { id };
}

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  const response = await request("POST", "/api/v1/auth/register", {
    body: { email: `${randomUUID()}@visualize.test`, displayName, password },
  });
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

async function removeVisualizationFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@visualize.test')`;
  const orgs = `(SELECT id FROM organizations WHERE slug LIKE 'visualize-test-%')`;
  await active.query(
    `DELETE FROM visualization_concepts
     WHERE owner_user_id IN ${owners}
        OR created_by_user_id IN ${owners}
        OR owner_organization_id IN ${orgs}`,
  );
  await active.query(
    `DELETE FROM ai_tasks
     WHERE owner_user_id IN ${owners}
        OR created_by_user_id IN ${owners}
        OR owner_organization_id IN ${orgs}`,
  );
  await active.query(
    `DELETE FROM design_projects
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
  await active.query(`DELETE FROM organizations WHERE slug LIKE 'visualize-test-%'`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@visualize.test'`);
}
