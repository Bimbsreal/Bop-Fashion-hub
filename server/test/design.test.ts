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

const password = "design-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Project = {
  id: string;
  name: string;
  description: string;
  status: string;
  visibility: string;
  access: string;
  latestRevision: number | null;
  garments: { id: string; role: string }[];
  media: { id: string; role: string }[];
  organization: { kind: string } | null;
};

type Revision = {
  id: string;
  revisionNumber: number;
  name: string;
  garments: { id: string; role: string }[];
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so design tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so design tests were not executed.");
  await migrate(pool);
  await removeDesignFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeDesignFixtures(pool);
  await closePool();
});

test("a private design project is visible only to its owner and keeps its first revision", async () => {
  const owner = await register("Owner");
  const stranger = await register("Stranger");
  const created = await request("POST", "/api/v1/design-projects", {
    cookie: owner.cookie,
    body: { name: "Indigo set", description: "First notes", visibility: "private" },
  });
  assert.equal(created.status, 201);
  const project = (created.body as { project: Project }).project;
  assert.equal(project.status, "draft");
  assert.equal(project.access, "manage");
  assert.equal(project.latestRevision, 1);
  assert.equal(JSON.stringify(created.body).includes("storageKey"), false);

  const hidden = await request("GET", `/api/v1/design-projects/${project.id}`, { cookie: stranger.cookie });
  assert.equal(hidden.status, 404);
  const anonymous = await request("POST", "/api/v1/design-projects", { body: { name: "Nope" } });
  assert.equal(anonymous.status, 401);

  const skipped = await request("POST", `/api/v1/design-projects/${project.id}/status`, {
    cookie: owner.cookie,
    body: { status: "ready_for_review" },
  });
  assert.equal(skipped.status, 400);
  assert.equal((skipped.body as { error: { code: string } }).error.code, "invalid_transition");
  const stillDraft = await request("GET", `/api/v1/design-projects/${project.id}`, { cookie: owner.cookie });
  assert.equal((stillDraft.body as { project: Project }).project.status, "draft");

  const statusOnPatch = await request("PATCH", `/api/v1/design-projects/${project.id}`, {
    cookie: owner.cookie,
    body: { status: "archived" },
  });
  assert.equal(statusOnPatch.status, 400);

  const published = await request("PATCH", `/api/v1/design-projects/${project.id}`, {
    cookie: owner.cookie,
    body: { visibility: "public" },
  });
  assert.equal(published.status, 200);
  const open = await request("GET", `/api/v1/design-projects/${project.id}`);
  assert.equal(open.status, 200);
  const anonymousWrite = await request("PATCH", `/api/v1/design-projects/${project.id}`, { body: { name: "Taken" } });
  assert.equal(anonymousWrite.status, 401);

  const listed = await request("GET", "/api/v1/design-projects", { cookie: owner.cookie });
  assert.equal(
    (listed.body as { projects: Project[] }).projects.some((item) => item.id === project.id),
    true,
  );
  const strangerList = await request("GET", "/api/v1/design-projects", { cookie: stranger.cookie });
  assert.equal(
    (strangerList.body as { projects: Project[] }).projects.some((item) => item.id === project.id),
    true,
  );
});

test("organization members can edit, and only an owner or admin can archive", async () => {
  assert.ok(pool);
  const owner = await register("Studio owner");
  const member = await register("Studio member");
  const stranger = await register("Outsider");
  const slug = `design-test-${randomUUID().slice(0, 8)}`;
  const organization = await withTransaction((client) =>
    createOrganization(client, owner.id, { name: "Design Studio", slug, kind: "studio" }),
  );
  await withTransaction((client) =>
    addMember(client, owner.id, { organizationId: organization.id, userId: member.id, role: "member" }),
  );
  const created = await request("POST", "/api/v1/design-projects", {
    cookie: owner.cookie,
    body: { name: "House collection", organizationId: organization.id },
  });
  assert.equal(created.status, 201);
  const project = (created.body as { project: Project }).project;
  assert.equal(project.organization?.kind, "studio");
  assert.equal(project.access, "manage");

  const outsider = await request("GET", `/api/v1/design-projects/${project.id}`, { cookie: stranger.cookie });
  assert.equal(outsider.status, 404);
  const edited = await request("PATCH", `/api/v1/design-projects/${project.id}`, {
    cookie: member.cookie,
    body: { description: "Member notes" },
  });
  assert.equal(edited.status, 200);
  assert.equal((edited.body as { project: Project }).project.access, "edit");

  const memberArchive = await request("POST", `/api/v1/design-projects/${project.id}/status`, {
    cookie: member.cookie,
    body: { status: "archived" },
  });
  assert.equal(memberArchive.status, 403);
  await request("POST", `/api/v1/design-projects/${project.id}/status`, {
    cookie: owner.cookie,
    body: { status: "in_progress" },
  });
  const archived = await request("POST", `/api/v1/design-projects/${project.id}/status`, {
    cookie: owner.cookie,
    body: { status: "archived" },
  });
  assert.equal(archived.status, 200);
  const blocked = await request("PATCH", `/api/v1/design-projects/${project.id}`, {
    cookie: member.cookie,
    body: { name: "Changed while archived" },
  });
  assert.equal(blocked.status, 400);
  const reopened = await request("POST", `/api/v1/design-projects/${project.id}/status`, {
    cookie: owner.cookie,
    body: { status: "in_progress" },
  });
  assert.equal((reopened.body as { project: Project }).project.status, "in_progress");
  const memberDelete = await request("DELETE", `/api/v1/design-projects/${project.id}`, { cookie: member.cookie });
  assert.equal(memberDelete.status, 403);
  const stillThere = await request("GET", `/api/v1/design-projects/${project.id}`, { cookie: member.cookie });
  assert.equal(stillThere.status, 200);
});

test("revisions keep the earlier design state", async () => {
  const owner = await register("Reviser");
  const created = await request("POST", "/api/v1/design-projects", {
    cookie: owner.cookie,
    body: { name: "First cut" },
  });
  const project = (created.body as { project: Project }).project;
  const garment = await request("POST", "/api/v1/catalog/garments", {
    cookie: owner.cookie,
    body: { name: "Working agbada", terms: [{ kind: "garment_type", slug: "agbada" }] },
  });
  const garmentId = (garment.body as { garment: { id: string } }).garment.id;
  const linked = await request("POST", `/api/v1/design-projects/${project.id}/garments`, {
    cookie: owner.cookie,
    body: { garmentId, role: "primary" },
  });
  assert.equal(linked.status, 201);
  assert.equal((linked.body as { project: Project }).project.garments[0]?.role, "primary");

  await request("PATCH", `/api/v1/design-projects/${project.id}`, {
    cookie: owner.cookie,
    body: { name: "Second cut" },
  });
  const saved = await request("POST", `/api/v1/design-projects/${project.id}/revisions`, {
    cookie: owner.cookie,
    body: { note: "Renamed the study" },
  });
  assert.equal(saved.status, 201);
  const history = await request("GET", `/api/v1/design-projects/${project.id}/revisions?limit=10`, {
    cookie: owner.cookie,
  });
  const revisions = (history.body as { revisions: Revision[]; page: { total: number } }).revisions;
  assert.equal(history.status, 200);
  assert.equal((history.body as { page: { total: number } }).page.total, 2);
  const first = revisions.find((revision) => revision.revisionNumber === 1);
  const second = revisions.find((revision) => revision.revisionNumber === 2);
  assert.equal(first?.name, "First cut");
  assert.equal(first?.garments.length, 0);
  assert.equal(second?.name, "Second cut");
  assert.equal(second?.garments[0]?.id, garmentId);
  const olderPage = await request("GET", `/api/v1/design-projects/${project.id}/revisions?limit=1&offset=1`, {
    cookie: owner.cookie,
  });
  assert.equal((olderPage.body as { revisions: Revision[]; page: { total: number } }).page.total, 2);
  assert.equal((olderPage.body as { revisions: Revision[] }).revisions[0]?.revisionNumber, 1);

  assert.ok(pool);
  const active = pool;
  await assert.rejects(
    () =>
      active.query(
        `INSERT INTO design_revisions (
           design_project_id, revision_number, project_name, project_description, project_status, created_by_user_id
         )
         VALUES ($1, 2, 'Duplicate', '', 'draft', $2)`,
        [project.id, owner.id],
      ),
    /design_revisions_number_unique/,
  );
});

test("private garments and media cannot be attached by someone who cannot read them", async () => {
  const owner = await register("Maker");
  const other = await register("Other maker");
  const project = await request("POST", "/api/v1/design-projects", {
    cookie: owner.cookie,
    body: { name: "References" },
  });
  const projectId = (project.body as { project: Project }).project.id;
  const foreignGarment = await request("POST", "/api/v1/catalog/garments", {
    cookie: other.cookie,
    body: { name: "Private shirt" },
  });
  const foreignGarmentId = (foreignGarment.body as { garment: { id: string } }).garment.id;
  const deniedGarment = await request("POST", `/api/v1/design-projects/${projectId}/garments`, {
    cookie: owner.cookie,
    body: { garmentId: foreignGarmentId },
  });
  assert.equal(deniedGarment.status, 404);

  const ownGarment = await request("POST", "/api/v1/catalog/garments", {
    cookie: other.cookie,
    body: { name: "Media host" },
  });
  const hostId = (ownGarment.body as { garment: { id: string } }).garment.id;
  const foreignMedia = await request("POST", `/api/v1/catalog/garments/${hostId}/media`, {
    cookie: other.cookie,
    body: {
      role: "reference",
      mediaType: "image",
      mimeType: "image/png",
      byteSize: 12,
      storageKey: `design/${randomUUID()}.png`,
    },
  });
  const mediaId = (foreignMedia.body as { garment: { media: { id: string }[] } }).garment.media[0]?.id;
  assert.ok(mediaId);
  const deniedMedia = await request("POST", `/api/v1/design-projects/${projectId}/media`, {
    cookie: owner.cookie,
    body: { mediaId, role: "sketch" },
  });
  assert.equal(deniedMedia.status, 404);

  const ownHost = await request("POST", "/api/v1/catalog/garments", {
    cookie: owner.cookie,
    body: { name: "Own host" },
  });
  const ownHostId = (ownHost.body as { garment: { id: string } }).garment.id;
  const ownMedia = await request("POST", `/api/v1/catalog/garments/${ownHostId}/media`, {
    cookie: owner.cookie,
    body: {
      role: "sketch",
      mediaType: "image",
      mimeType: "image/png",
      byteSize: 20,
      storageKey: `design/${randomUUID()}.png`,
    },
  });
  const ownMediaId = (ownMedia.body as { garment: { media: { id: string }[] } }).garment.media[0]?.id;
  const linked = await request("POST", `/api/v1/design-projects/${projectId}/media`, {
    cookie: owner.cookie,
    body: { mediaId: ownMediaId, role: "sketch" },
  });
  assert.equal(linked.status, 201);
  assert.equal((linked.body as { project: Project }).project.media[0]?.role, "sketch");

  assert.ok(pool);
  const thumbnail = await pool.query<{ id: string }>(
    `INSERT INTO media_assets (
       owner_user_id, media_type, mime_type, byte_size, storage_key, status, variant, derivative_of_id
     )
     VALUES ($1, 'image', 'image/png', 8, $2, 'ready', 'thumbnail', $3)
     RETURNING id`,
    [owner.id, `thumbnails/${randomUUID()}.png`, ownMediaId],
  );
  const thumbnailId = thumbnail.rows[0]?.id;
  assert.ok(thumbnailId);
  const thumbnailDenied = await request("POST", `/api/v1/design-projects/${projectId}/media`, {
    cookie: owner.cookie,
    body: { mediaId: thumbnailId, role: "preview" },
  });
  assert.equal(thumbnailDenied.status, 400);
  assert.equal((thumbnailDenied.body as { error: { code: string } }).error.code, "invalid_media");

  const missing = await request("POST", `/api/v1/design-projects/${projectId}/garments`, {
    cookie: owner.cookie,
    body: { garmentId: randomUUID() },
  });
  assert.equal(missing.status, 404);
  const unchanged = await request("GET", `/api/v1/design-projects/${projectId}`, { cookie: owner.cookie });
  assert.equal((unchanged.body as { project: Project }).project.garments.length, 0);

  const removed = await request("DELETE", `/api/v1/design-projects/${projectId}`, { cookie: owner.cookie });
  assert.equal(removed.status, 204);
  const gone = await request("GET", `/api/v1/design-projects/${projectId}`, { cookie: owner.cookie });
  assert.equal(gone.status, 404);
});

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  const response = await request("POST", "/api/v1/auth/register", {
    body: { email: `${randomUUID()}@design.test`, displayName, password },
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

async function removeDesignFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@design.test')`;
  const orgs = `(SELECT id FROM organizations WHERE slug LIKE 'design-test-%')`;
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
  await active.query(`DELETE FROM organizations WHERE slug LIKE 'design-test-%'`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@design.test'`);
}
