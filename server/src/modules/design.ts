import type { PoolClient } from "pg";
import { activeMembership, actorMayAccessOwner, assertCanActForOwner, ownerColumns, ownerFromIds, type OwnerRef } from "./access";
import { forbidden, invalid, notFound } from "../errors";
import { getCatalogGarment } from "./fashion";
import { requireMedia } from "./uploads";

export type ProjectStatus = "draft" | "in_progress" | "ready_for_review" | "archived";
export type ProjectAccess = "manage" | "edit" | "view";

const statuses = new Set<ProjectStatus>(["draft", "in_progress", "ready_for_review", "archived"]);
const garmentRoles = new Set(["primary", "reference"]);
const mediaRoles = new Set(["sketch", "reference", "fabric", "inspiration", "preview"]);
const transitions: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ["in_progress", "archived"],
  in_progress: ["ready_for_review", "archived"],
  ready_for_review: ["in_progress", "archived"],
  archived: ["in_progress"],
};

export type DesignProjectView = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  visibility: "private" | "public";
  access: ProjectAccess;
  createdBy: { displayName: string } | null;
  organization: { name: string; slug: string; kind: string } | null;
  garments: { id: string; name: string; role: string }[];
  media: { id: string; role: string; mimeType: string; mediaType: string }[];
  latestRevision: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DesignRevisionView = {
  id: string;
  revisionNumber: number;
  note: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdBy: { displayName: string } | null;
  garments: { id: string; role: string }[];
  media: { id: string; role: string }[];
  createdAt: string;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  visibility: "private" | "public";
  owner_user_id: string | null;
  owner_organization_id: string | null;
  creator_name: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  organization_kind: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function createDesignProject(
  client: PoolClient,
  actorUserId: string,
  input: { owner: OwnerRef; name: string; description?: string; visibility?: "private" | "public" },
): Promise<DesignProjectView> {
  if (input.owner.organizationId) {
    const organization = await client.query<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [input.owner.organizationId],
    );
    if (organization.rows[0]?.status !== "active") throw invalid("invalid_owner", "Organization is not active.");
  }
  await assertCanActForOwner(client, actorUserId, input.owner);
  const columns = ownerColumns(input.owner);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO design_projects (
       name, description, owner_user_id, owner_organization_id, created_by_user_id, visibility
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      cleanName(input.name),
      cleanDescription(input.description),
      columns.ownerUserId,
      columns.ownerOrganizationId,
      actorUserId,
      input.visibility ?? "private",
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_name", "Project name is required.");
  await insertRevision(client, actorUserId, id, "");
  return requireProject(client, actorUserId, id);
}

export async function updateDesignProject(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  input: { name?: string; description?: string; visibility?: "private" | "public" },
): Promise<DesignProjectView> {
  if (input.name === undefined && input.description === undefined && input.visibility === undefined) {
    throw invalid("invalid_body", "No project changes were provided.");
  }
  const project = await lockProject(client, projectId);
  await assertCanEdit(client, actorUserId, project);
  assertOpen(project.status);
  await client.query(
    `UPDATE design_projects SET name = $2, description = $3, visibility = $4 WHERE id = $1`,
    [
      projectId,
      input.name === undefined ? project.name : cleanName(input.name),
      input.description === undefined ? project.description : cleanDescription(input.description),
      input.visibility ?? project.visibility,
    ],
  );
  return requireProject(client, actorUserId, projectId);
}

export async function changeDesignStatus(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  nextStatus: string,
): Promise<DesignProjectView> {
  if (!isStatus(nextStatus)) throw invalid("invalid_status", "Project status is not recognized.");
  const project = await lockProject(client, projectId);
  await assertCanEdit(client, actorUserId, project);
  if (!transitions[project.status].includes(nextStatus)) {
    throw invalid("invalid_transition", "That status change is not allowed.");
  }
  if (project.status === "archived" || nextStatus === "archived") {
    await assertCanManage(client, actorUserId, project);
  }
  await client.query(`UPDATE design_projects SET status = $2 WHERE id = $1`, [projectId, nextStatus]);
  return requireProject(client, actorUserId, projectId);
}

export async function linkDesignGarment(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  input: { garmentId: string; role?: string },
): Promise<DesignProjectView> {
  const role = input.role ?? "reference";
  if (!garmentRoles.has(role)) throw invalid("invalid_role", "Garment role is not recognized.");
  const project = await lockProject(client, projectId);
  await assertCanEdit(client, actorUserId, project);
  assertOpen(project.status);
  await getCatalogGarment(client, actorUserId, input.garmentId);
  if (role === "primary") {
    await client.query(
      `UPDATE design_project_garments SET role = 'reference'
       WHERE design_project_id = $1 AND role = 'primary' AND garment_id <> $2`,
      [projectId, input.garmentId],
    );
  }
  await client.query(
    `INSERT INTO design_project_garments (design_project_id, garment_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (design_project_id, garment_id) DO UPDATE SET role = EXCLUDED.role`,
    [projectId, input.garmentId, role],
  );
  return requireProject(client, actorUserId, projectId);
}

export async function unlinkDesignGarment(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  garmentId: string,
): Promise<DesignProjectView> {
  const project = await lockProject(client, projectId);
  await assertCanEdit(client, actorUserId, project);
  assertOpen(project.status);
  const removed = await client.query(
    `DELETE FROM design_project_garments WHERE design_project_id = $1 AND garment_id = $2`,
    [projectId, garmentId],
  );
  if (!removed.rowCount) throw notFound("Garment link was not found.");
  return requireProject(client, actorUserId, projectId);
}

export async function linkDesignMedia(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  input: { mediaId: string; role?: string },
): Promise<DesignProjectView> {
  const role = input.role ?? "reference";
  if (!mediaRoles.has(role)) throw invalid("invalid_role", "Media role is not recognized.");
  const project = await lockProject(client, projectId);
  await assertCanEdit(client, actorUserId, project);
  assertOpen(project.status);
  const media = await requireMedia(client, actorUserId, input.mediaId);
  if (media.variant !== "original") throw invalid("invalid_media", "Associate the original image.");
  await client.query(
    `INSERT INTO design_project_media (design_project_id, media_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (design_project_id, media_id) DO UPDATE SET role = EXCLUDED.role`,
    [projectId, input.mediaId, role],
  );
  return requireProject(client, actorUserId, projectId);
}

export async function unlinkDesignMedia(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  mediaId: string,
): Promise<DesignProjectView> {
  const project = await lockProject(client, projectId);
  await assertCanEdit(client, actorUserId, project);
  assertOpen(project.status);
  const removed = await client.query(
    `DELETE FROM design_project_media WHERE design_project_id = $1 AND media_id = $2`,
    [projectId, mediaId],
  );
  if (!removed.rowCount) throw notFound("Media link was not found.");
  return requireProject(client, actorUserId, projectId);
}

export async function createDesignRevision(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  note: string | undefined,
): Promise<DesignRevisionView> {
  const project = await lockProject(client, projectId);
  await assertCanEdit(client, actorUserId, project);
  assertOpen(project.status);
  const revisionId = await insertRevision(client, actorUserId, projectId, cleanNote(note));
  const revision = await loadRevision(client, revisionId);
  if (!revision) throw notFound("Revision was not found.");
  return revision;
}

export async function listDesignRevisions(
  client: PoolClient,
  actorUserId: string | null,
  projectId: string,
  query: { limit: number; offset: number },
): Promise<{ revisions: DesignRevisionView[]; total: number }> {
  await requireProject(client, actorUserId, projectId);
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM design_revisions WHERE design_project_id = $1`,
    [projectId],
  );
  const page = await client.query<{ id: string }>(
    `SELECT id FROM design_revisions
     WHERE design_project_id = $1
     ORDER BY revision_number DESC
     LIMIT $2 OFFSET $3`,
    [projectId, query.limit, query.offset],
  );
  const revisions: DesignRevisionView[] = [];
  for (const row of page.rows) {
    const revision = await loadRevision(client, row.id);
    if (revision) revisions.push(revision);
  }
  return { revisions, total: Number(total.rows[0]?.total ?? 0) };
}

export async function listDesignProjects(
  client: PoolClient,
  actorUserId: string | null,
  query: { limit: number; offset: number; status?: ProjectStatus },
): Promise<{ projects: DesignProjectView[]; total: number }> {
  const params: unknown[] = [];
  const actor = bind(params, actorUserId);
  const where = [visibleSql(actor)];
  if (query.status) where.push(`project.status = ${bind(params, query.status)}`);
  const whereSql = where.join(" AND ");
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM design_projects AS project WHERE ${whereSql}`,
    params,
  );
  const pageParams = [...params];
  const limit = bind(pageParams, query.limit);
  const offset = bind(pageParams, query.offset);
  const page = await client.query<{ id: string }>(
    `SELECT project.id FROM design_projects AS project
     WHERE ${whereSql}
     ORDER BY project.created_at DESC, project.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    pageParams,
  );
  const projects: DesignProjectView[] = [];
  for (const row of page.rows) {
    const project = await loadProject(client, actorUserId, row.id);
    if (project) projects.push(project);
  }
  return { projects, total: Number(total.rows[0]?.total ?? 0) };
}

export async function requireProject(
  client: PoolClient,
  actorUserId: string | null,
  projectId: string,
): Promise<DesignProjectView> {
  const project = await loadProject(client, actorUserId, projectId);
  if (!project) throw notFound("Design project was not found.");
  return project;
}

export async function deleteDesignProject(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
): Promise<void> {
  const project = await lockProject(client, projectId);
  if (!(await canRead(client, actorUserId, project))) throw notFound("Design project was not found.");
  await assertCanManage(client, actorUserId, project);
  await client.query(`DELETE FROM design_projects WHERE id = $1`, [projectId]);
}

async function insertRevision(
  client: PoolClient,
  actorUserId: string,
  projectId: string,
  note: string,
): Promise<string> {
  const project = await client.query<{ name: string; description: string; status: ProjectStatus }>(
    `SELECT name, description, status FROM design_projects WHERE id = $1 FOR UPDATE`,
    [projectId],
  );
  const current = project.rows[0];
  if (!current) throw notFound("Design project was not found.");
  const next = await client.query<{ revision_number: number }>(
    `SELECT coalesce(max(revision_number), 0) + 1 AS revision_number
     FROM design_revisions WHERE design_project_id = $1`,
    [projectId],
  );
  const revisionNumber = Number(next.rows[0]?.revision_number ?? 1);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO design_revisions (
       design_project_id, revision_number, note, project_name, project_description, project_status, created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [projectId, revisionNumber, note, current.name, current.description, current.status, actorUserId],
  );
  const revisionId = inserted.rows[0]?.id;
  if (!revisionId) throw invalid("invalid_revision", "Revision could not be saved.");
  await client.query(
    `INSERT INTO design_revision_garments (revision_id, garment_id, role)
     SELECT $1, garment_id, role FROM design_project_garments WHERE design_project_id = $2`,
    [revisionId, projectId],
  );
  await client.query(
    `INSERT INTO design_revision_media (revision_id, media_id, role)
     SELECT $1, media_id, role FROM design_project_media WHERE design_project_id = $2`,
    [revisionId, projectId],
  );
  return revisionId;
}

async function loadProject(
  client: PoolClient,
  actorUserId: string | null,
  projectId: string,
): Promise<DesignProjectView | null> {
  const params: unknown[] = [projectId];
  const actor = bind(params, actorUserId);
  const found = await client.query<ProjectRow>(
    `SELECT
       project.id, project.name, project.description, project.status, project.visibility,
       project.owner_user_id, project.owner_organization_id, project.created_at, project.updated_at,
       creator.display_name AS creator_name,
       org.name AS organization_name, org.slug AS organization_slug, org.kind AS organization_kind
     FROM design_projects AS project
     LEFT JOIN users AS creator ON creator.id = project.created_by_user_id
     LEFT JOIN organizations AS org ON org.id = project.owner_organization_id
     WHERE project.id = $1 AND ${visibleSql(actor)}`,
    params,
  );
  const row = found.rows[0];
  if (!row) return null;
  const garments = await client.query<{ id: string; name: string; role: string }>(
    `SELECT garments.id, garments.name, design_project_garments.role
     FROM design_project_garments
     JOIN garments ON garments.id = design_project_garments.garment_id
     WHERE design_project_id = $1
     ORDER BY design_project_garments.role, garments.name`,
    [projectId],
  );
  const media = await client.query<{ id: string; role: string; mime_type: string; media_type: string }>(
    `SELECT media_assets.id, design_project_media.role, media_assets.mime_type, media_assets.media_type
     FROM design_project_media
     JOIN media_assets ON media_assets.id = design_project_media.media_id
     WHERE design_project_id = $1
     ORDER BY design_project_media.role`,
    [projectId],
  );
  const latest = await client.query<{ revision_number: number }>(
    `SELECT max(revision_number) AS revision_number FROM design_revisions WHERE design_project_id = $1`,
    [projectId],
  );
  const membership = row.owner_organization_id && actorUserId
    ? await activeMembership(client, actorUserId, row.owner_organization_id)
    : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    visibility: row.visibility,
    access: accessFor(row, actorUserId, membership?.role ?? null),
    createdBy: row.creator_name ? { displayName: row.creator_name } : null,
    organization:
      row.organization_name && row.organization_slug && row.organization_kind
        ? { name: row.organization_name, slug: row.organization_slug, kind: row.organization_kind }
        : null,
    garments: garments.rows,
    media: media.rows.map((item) => ({
      id: item.id,
      role: item.role,
      mimeType: item.mime_type,
      mediaType: item.media_type,
    })),
    latestRevision:
      latest.rows[0]?.revision_number == null ? null : Number(latest.rows[0].revision_number),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function loadRevision(client: PoolClient, revisionId: string): Promise<DesignRevisionView | null> {
  const found = await client.query<{
    id: string;
    revision_number: number;
    note: string;
    project_name: string;
    project_description: string;
    project_status: ProjectStatus;
    creator_name: string | null;
    created_at: Date;
  }>(
    `SELECT design_revisions.id, revision_number, note, project_name, project_description, project_status,
            users.display_name AS creator_name, design_revisions.created_at
     FROM design_revisions
     LEFT JOIN users ON users.id = design_revisions.created_by_user_id
     WHERE design_revisions.id = $1`,
    [revisionId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const garments = await client.query<{ id: string; role: string }>(
    `SELECT garment_id AS id, role FROM design_revision_garments WHERE revision_id = $1 ORDER BY role`,
    [revisionId],
  );
  const media = await client.query<{ id: string; role: string }>(
    `SELECT media_id AS id, role FROM design_revision_media WHERE revision_id = $1 ORDER BY role`,
    [revisionId],
  );
  return {
    id: row.id,
    revisionNumber: Number(row.revision_number),
    note: row.note,
    name: row.project_name,
    description: row.project_description,
    status: row.project_status,
    createdBy: row.creator_name ? { displayName: row.creator_name } : null,
    garments: garments.rows,
    media: media.rows,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function lockProject(client: PoolClient, projectId: string): Promise<ProjectRow> {
  const found = await client.query<ProjectRow>(
    `SELECT
       project.id, project.name, project.description, project.status, project.visibility,
       project.owner_user_id, project.owner_organization_id, project.created_at, project.updated_at,
       NULL::text AS creator_name, NULL::text AS organization_name,
       NULL::text AS organization_slug, NULL::text AS organization_kind
     FROM design_projects AS project
     WHERE project.id = $1
     FOR UPDATE`,
    [projectId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Design project was not found.");
  return row;
}

async function canRead(client: PoolClient, actorUserId: string | null, project: ProjectRow): Promise<boolean> {
  if (project.visibility === "public") return true;
  return actorMayAccessOwner(client, actorUserId, ownerFromIds(project.owner_user_id, project.owner_organization_id));
}

async function assertCanEdit(client: PoolClient, actorUserId: string, project: ProjectRow): Promise<void> {
  if (!(await canRead(client, actorUserId, project))) throw notFound("Design project was not found.");
  const allowed = await actorMayAccessOwner(
    client,
    actorUserId,
    ownerFromIds(project.owner_user_id, project.owner_organization_id),
  );
  if (!allowed) throw forbidden("You cannot change this design project.");
}

async function assertCanManage(client: PoolClient, actorUserId: string, project: ProjectRow): Promise<void> {
  if (project.owner_user_id) {
    if (project.owner_user_id !== actorUserId) throw forbidden("You cannot manage this design project.");
    return;
  }
  if (!project.owner_organization_id) throw forbidden("You cannot manage this design project.");
  const membership = await activeMembership(client, actorUserId, project.owner_organization_id);
  if (!membership) throw notFound("Design project was not found.");
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw forbidden("Only an owner or admin can manage this design project.");
  }
}

function assertOpen(status: ProjectStatus) {
  if (status === "archived") throw invalid("invalid_status", "Reopen the project before changing it.");
}

function accessFor(row: ProjectRow, actorUserId: string | null, role: string | null): ProjectAccess {
  if (row.owner_user_id && actorUserId === row.owner_user_id) return "manage";
  if (role === "owner" || role === "admin") return "manage";
  if (role === "member") return "edit";
  return "view";
}

function isStatus(value: string): value is ProjectStatus {
  return statuses.has(value as ProjectStatus);
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 160) throw invalid("invalid_name", "Project name is required.");
  return trimmed;
}

function cleanDescription(description: string | undefined): string {
  const trimmed = description?.trim() ?? "";
  if (trimmed.length > 8000) throw invalid("invalid_description", "Description is too long.");
  return trimmed;
}

function cleanNote(note: string | undefined): string {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > 2000) throw invalid("invalid_note", "Revision note is too long.");
  return trimmed;
}

function visibleSql(actor: string): string {
  return `(
    project.visibility = 'public'
    OR (${actor}::uuid IS NOT NULL AND project.owner_user_id = ${actor}::uuid)
    OR (${actor}::uuid IS NOT NULL AND EXISTS (
      SELECT 1 FROM organization_memberships AS membership
      WHERE membership.organization_id = project.owner_organization_id
        AND membership.user_id = ${actor}::uuid
        AND membership.status = 'active'
    ))
  )`;
}

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}
