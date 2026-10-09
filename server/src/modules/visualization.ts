import type { PoolClient } from "pg";
import { activeMembership, actorMayAccessOwner, assertCanActForOwner, ownerColumns, ownerFromIds, type OwnerRef } from "./access";
import { forbidden, invalid, notFound } from "../errors";
import { requireProject } from "./design";
import { getCatalogGarment } from "./fashion";
import { requireMedia } from "./uploads";

export type VisualizationStatus = "draft" | "arranged" | "archived";
export type VisualizationMethod = "reference_board" | "concept_preview" | "manual_variation";
export type ReferenceOrigin = "original_reference" | "manual_upload" | "design_revision";
export type VisualizationAccess = "manage" | "edit" | "view";

const statuses = new Set<VisualizationStatus>(["draft", "arranged", "archived"]);
const methods = new Set<VisualizationMethod>(["reference_board", "concept_preview", "manual_variation"]);
const origins = new Set<ReferenceOrigin>(["original_reference", "manual_upload", "design_revision"]);
const transitions: Record<VisualizationStatus, VisualizationStatus[]> = {
  draft: ["arranged", "archived"],
  arranged: ["draft", "archived"],
  archived: ["draft"],
};

export type VisualizationReferenceView = {
  mediaId: string;
  position: number;
  origin: ReferenceOrigin;
  note: string;
  available: boolean;
  filename: string | null;
  mimeType: string | null;
  status: string | null;
};

export type VisualizationConceptView = {
  id: string;
  title: string;
  notes: string;
  status: VisualizationStatus;
  method: VisualizationMethod;
  visibility: "private" | "public";
  access: VisualizationAccess;
  generated: false;
  referenceCount: number;
  designProject: { id: string; name: string; status: string } | { id: string; available: false } | null;
  revision: { id: string; revisionNumber: number } | { id: string; available: false } | null;
  garment:
    | {
        id: string;
        name: string;
        description: string;
        garmentType: { kind: string; slug: string; name: string } | null;
        terms: { kind: string; slug: string; name: string }[];
      }
    | { id: string; available: false }
    | null;
  preview: { mediaId: string; origin: ReferenceOrigin; available: boolean; filename: string | null } | null;
  references: VisualizationReferenceView[];
  createdAt: string;
  updatedAt: string;
};

export type VisualizationSummary = {
  id: string;
  title: string;
  status: VisualizationStatus;
  method: VisualizationMethod;
  visibility: "private" | "public";
  access: VisualizationAccess;
  generated: false;
  referenceCount: number;
  updatedAt: string;
  previewMediaId: string | null;
  designProjectName: string | null;
};

type ConceptRow = {
  id: string;
  title: string;
  notes: string;
  status: VisualizationStatus;
  method: VisualizationMethod;
  visibility: "private" | "public";
  owner_user_id: string | null;
  owner_organization_id: string | null;
  design_project_id: string | null;
  revision_id: string | null;
  garment_id: string | null;
  preview_media_id: string | null;
  preview_origin: ReferenceOrigin | null;
  created_at: Date;
  updated_at: Date;
};

export async function createVisualization(
  client: PoolClient,
  actorUserId: string,
  input: {
    owner: OwnerRef;
    title: string;
    notes?: string;
    visibility?: "private" | "public";
    method?: string;
    designProjectId?: string | null;
    garmentId?: string | null;
  },
): Promise<VisualizationConceptView> {
  if (input.owner.organizationId) {
    const organization = await client.query<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [input.owner.organizationId],
    );
    if (organization.rows[0]?.status !== "active") throw invalid("invalid_owner", "Organization is not active.");
  }
  await assertCanActForOwner(client, actorUserId, input.owner);
  const method = input.method === undefined ? "reference_board" : cleanMethod(input.method);
  if (input.designProjectId) await requireProject(client, actorUserId, input.designProjectId);
  if (input.garmentId) await getCatalogGarment(client, actorUserId, input.garmentId);
  const columns = ownerColumns(input.owner);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO visualization_concepts (
       title, notes, owner_user_id, owner_organization_id, created_by_user_id,
       visibility, method, design_project_id, garment_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      cleanTitle(input.title),
      cleanNotes(input.notes),
      columns.ownerUserId,
      columns.ownerOrganizationId,
      actorUserId,
      input.visibility ?? "private",
      method,
      input.designProjectId ?? null,
      input.garmentId ?? null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_title", "Concept title is required.");
  return requireVisualization(client, actorUserId, id);
}

export async function updateVisualization(
  client: PoolClient,
  actorUserId: string,
  conceptId: string,
  input: {
    title?: string;
    notes?: string;
    visibility?: "private" | "public";
    method?: string;
    designProjectId?: string | null;
    revisionId?: string | null;
    garmentId?: string | null;
    previewMediaId?: string | null;
  },
): Promise<VisualizationConceptView> {
  if (
    input.title === undefined &&
    input.notes === undefined &&
    input.visibility === undefined &&
    input.method === undefined &&
    input.designProjectId === undefined &&
    input.revisionId === undefined &&
    input.garmentId === undefined &&
    input.previewMediaId === undefined
  ) {
    throw invalid("invalid_body", "No concept changes were provided.");
  }
  const current = await lockConcept(client, conceptId);
  await assertCanEdit(client, actorUserId, current);
  assertOpen(current.status);

  const designProjectId = input.designProjectId === undefined ? current.design_project_id : input.designProjectId;
  let revisionId = input.revisionId === undefined ? current.revision_id : input.revisionId;
  if (
    input.designProjectId !== undefined &&
    input.revisionId === undefined &&
    input.designProjectId !== current.design_project_id
  ) {
    revisionId = null;
  }
  if (designProjectId) await requireProject(client, actorUserId, designProjectId);
  if (revisionId) await assertRevision(client, revisionId, designProjectId);
  if (input.garmentId) await getCatalogGarment(client, actorUserId, input.garmentId);

  let previewMediaId = input.previewMediaId === undefined ? current.preview_media_id : input.previewMediaId;
  let previewOrigin = current.preview_origin;
  if (input.previewMediaId === null) {
    previewOrigin = null;
  } else if (input.previewMediaId) {
    const reference = await client.query<{ origin: ReferenceOrigin }>(
      `SELECT origin FROM visualization_references WHERE concept_id = $1 AND media_id = $2`,
      [conceptId, input.previewMediaId],
    );
    const origin = reference.rows[0]?.origin;
    if (!origin) throw invalid("invalid_preview", "Choose a reference already on this concept.");
    previewOrigin = origin;
  }
  if (previewMediaId && input.previewMediaId === undefined) {
    const stillThere = await client.query(
      `SELECT 1 FROM visualization_references WHERE concept_id = $1 AND media_id = $2`,
      [conceptId, previewMediaId],
    );
    if (!stillThere.rowCount) {
      previewMediaId = null;
      previewOrigin = null;
    }
  }

  await client.query(
    `UPDATE visualization_concepts
     SET title = $2, notes = $3, visibility = $4, method = $5,
         design_project_id = $6, revision_id = $7, garment_id = $8,
         preview_media_id = $9, preview_origin = $10
     WHERE id = $1`,
    [
      conceptId,
      input.title === undefined ? current.title : cleanTitle(input.title),
      input.notes === undefined ? current.notes : cleanNotes(input.notes),
      input.visibility ?? current.visibility,
      input.method === undefined ? current.method : cleanMethod(input.method),
      designProjectId,
      revisionId,
      input.garmentId === undefined ? current.garment_id : input.garmentId,
      previewMediaId,
      previewOrigin,
    ],
  );
  return requireVisualization(client, actorUserId, conceptId);
}

export async function changeVisualizationStatus(
  client: PoolClient,
  actorUserId: string,
  conceptId: string,
  nextStatus: string,
): Promise<VisualizationConceptView> {
  if (!isStatus(nextStatus)) throw invalid("invalid_status", "Visualization status is not recognized.");
  const current = await lockConcept(client, conceptId);
  await assertCanEdit(client, actorUserId, current);
  if (!transitions[current.status].includes(nextStatus)) {
    throw invalid("invalid_transition", "That status change is not allowed.");
  }
  if (current.status === "archived" || nextStatus === "archived") {
    await assertCanManage(client, actorUserId, current);
  }
  await client.query(`UPDATE visualization_concepts SET status = $2 WHERE id = $1`, [conceptId, nextStatus]);
  return requireVisualization(client, actorUserId, conceptId);
}

export async function addVisualizationReference(
  client: PoolClient,
  actorUserId: string,
  conceptId: string,
  input: { mediaId: string; origin: string; note?: string },
): Promise<VisualizationConceptView> {
  if (!origins.has(input.origin as ReferenceOrigin)) throw invalid("invalid_origin", "Reference origin is not recognized.");
  const current = await lockConcept(client, conceptId);
  await assertCanEdit(client, actorUserId, current);
  assertOpen(current.status);
  const media = await requireMedia(client, actorUserId, input.mediaId);
  if (media.variant !== "original") throw invalid("invalid_media", "Associate the original image.");
  const existing = await client.query(
    `SELECT 1 FROM visualization_references WHERE concept_id = $1 AND media_id = $2`,
    [conceptId, input.mediaId],
  );
  if (existing.rowCount) throw invalid("conflict", "This image is already a reference.");
  const count = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM visualization_references WHERE concept_id = $1`,
    [conceptId],
  );
  const total = Number(count.rows[0]?.total ?? 0);
  if (total >= 24) throw invalid("invalid_reference", "A concept can hold 24 references.");
  const origin = input.origin as ReferenceOrigin;
  await client.query(
    `INSERT INTO visualization_references (concept_id, media_id, position, origin, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [conceptId, input.mediaId, total + 1, origin, cleanReferenceNote(input.note)],
  );
  if (!current.preview_media_id) {
    await client.query(
      `UPDATE visualization_concepts SET preview_media_id = $2, preview_origin = $3 WHERE id = $1`,
      [conceptId, input.mediaId, origin],
    );
  }
  return requireVisualization(client, actorUserId, conceptId);
}

export async function updateVisualizationReference(
  client: PoolClient,
  actorUserId: string,
  conceptId: string,
  mediaId: string,
  note: string,
): Promise<VisualizationConceptView> {
  const current = await lockConcept(client, conceptId);
  await assertCanEdit(client, actorUserId, current);
  assertOpen(current.status);
  const updated = await client.query(
    `UPDATE visualization_references SET note = $3 WHERE concept_id = $1 AND media_id = $2`,
    [conceptId, mediaId, cleanReferenceNote(note)],
  );
  if (!updated.rowCount) throw notFound("Reference was not found.");
  return requireVisualization(client, actorUserId, conceptId);
}

export async function removeVisualizationReference(
  client: PoolClient,
  actorUserId: string,
  conceptId: string,
  mediaId: string,
): Promise<VisualizationConceptView> {
  const current = await lockConcept(client, conceptId);
  await assertCanEdit(client, actorUserId, current);
  assertOpen(current.status);
  const removed = await client.query(
    `DELETE FROM visualization_references WHERE concept_id = $1 AND media_id = $2`,
    [conceptId, mediaId],
  );
  if (!removed.rowCount) throw notFound("Reference was not found.");
  await renumberReferences(client, conceptId);
  if (current.preview_media_id === mediaId) {
    const next = await client.query<{ media_id: string; origin: ReferenceOrigin }>(
      `SELECT media_id, origin FROM visualization_references WHERE concept_id = $1 ORDER BY position LIMIT 1`,
      [conceptId],
    );
    const replacement = next.rows[0];
    await client.query(
      `UPDATE visualization_concepts SET preview_media_id = $2, preview_origin = $3 WHERE id = $1`,
      [conceptId, replacement?.media_id ?? null, replacement?.origin ?? null],
    );
  }
  return requireVisualization(client, actorUserId, conceptId);
}

export async function reorderVisualizationReferences(
  client: PoolClient,
  actorUserId: string,
  conceptId: string,
  mediaIds: string[],
): Promise<VisualizationConceptView> {
  const current = await lockConcept(client, conceptId);
  await assertCanEdit(client, actorUserId, current);
  assertOpen(current.status);
  const existing = await client.query<{ media_id: string; origin: ReferenceOrigin; note: string }>(
    `SELECT media_id, origin, note FROM visualization_references WHERE concept_id = $1 ORDER BY position`,
    [conceptId],
  );
  const currentIds = existing.rows.map((row) => row.media_id);
  if (mediaIds.length !== currentIds.length || new Set(mediaIds).size !== mediaIds.length) {
    throw invalid("invalid_order", "Provide each reference once.");
  }
  if (mediaIds.some((id) => !currentIds.includes(id))) throw invalid("invalid_order", "Provide each reference once.");
  const byId = new Map(existing.rows.map((row) => [row.media_id, row]));
  await client.query(`DELETE FROM visualization_references WHERE concept_id = $1`, [conceptId]);
  for (let index = 0; index < mediaIds.length; index += 1) {
    const mediaId = mediaIds[index];
    const row = mediaId ? byId.get(mediaId) : undefined;
    if (!row) throw invalid("invalid_order", "Provide each reference once.");
    await client.query(
      `INSERT INTO visualization_references (concept_id, media_id, position, origin, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [conceptId, row.media_id, index + 1, row.origin, row.note],
    );
  }
  return requireVisualization(client, actorUserId, conceptId);
}

export async function listVisualizations(
  client: PoolClient,
  actorUserId: string | null,
  query: { limit: number; offset: number; status?: VisualizationStatus },
): Promise<{ concepts: VisualizationSummary[]; total: number }> {
  const params: unknown[] = [];
  const actor = bind(params, actorUserId);
  const where = [visibleSql(actor)];
  if (query.status) where.push(`concept.status = ${bind(params, query.status)}`);
  const whereSql = where.join(" AND ");
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM visualization_concepts AS concept WHERE ${whereSql}`,
    params,
  );
  const pageParams = [...params];
  const limit = bind(pageParams, query.limit);
  const offset = bind(pageParams, query.offset);
  const page = await client.query<{ id: string }>(
    `SELECT concept.id FROM visualization_concepts AS concept
     WHERE ${whereSql}
     ORDER BY concept.updated_at DESC, concept.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    pageParams,
  );
  const concepts: VisualizationSummary[] = [];
  for (const row of page.rows) {
    const concept = await loadSummary(client, actorUserId, row.id);
    if (concept) concepts.push(concept);
  }
  return { concepts, total: Number(total.rows[0]?.total ?? 0) };
}

export async function requireVisualization(
  client: PoolClient,
  actorUserId: string | null,
  conceptId: string,
): Promise<VisualizationConceptView> {
  const concept = await loadConcept(client, actorUserId, conceptId);
  if (!concept) throw notFound("Visualization was not found.");
  return concept;
}

async function assertRevision(client: PoolClient, revisionId: string, designProjectId: string | null) {
  if (!designProjectId) throw invalid("invalid_revision", "Choose a design project before a revision.");
  const found = await client.query<{ design_project_id: string }>(
    `SELECT design_project_id FROM design_revisions WHERE id = $1`,
    [revisionId],
  );
  const projectId = found.rows[0]?.design_project_id;
  if (!projectId) throw notFound("Revision was not found.");
  if (projectId !== designProjectId) throw invalid("invalid_revision", "Revision belongs to a different design project.");
}

async function renumberReferences(client: PoolClient, conceptId: string) {
  const rows = await client.query<{ media_id: string }>(
    `SELECT media_id FROM visualization_references WHERE concept_id = $1 ORDER BY position`,
    [conceptId],
  );
  for (let index = 0; index < rows.rows.length; index += 1) {
    const mediaId = rows.rows[index]?.media_id;
    await client.query(
      `UPDATE visualization_references SET position = $3 WHERE concept_id = $1 AND media_id = $2`,
      [conceptId, mediaId, index + 1],
    );
  }
}

async function loadSummary(
  client: PoolClient,
  actorUserId: string | null,
  conceptId: string,
): Promise<VisualizationSummary | null> {
  const params: unknown[] = [conceptId];
  const actor = bind(params, actorUserId);
  const found = await client.query<ConceptRow & { reference_count: number; project_name: string | null }>(
    `SELECT
       concept.id, concept.title, concept.notes, concept.status, concept.method, concept.visibility,
       concept.owner_user_id, concept.owner_organization_id, concept.design_project_id, concept.revision_id,
       concept.garment_id, concept.preview_media_id, concept.preview_origin, concept.created_at, concept.updated_at,
       (SELECT count(*)::int FROM visualization_references WHERE concept_id = concept.id) AS reference_count,
       project.name AS project_name
     FROM visualization_concepts AS concept
     LEFT JOIN design_projects AS project ON project.id = concept.design_project_id
     WHERE concept.id = $1 AND ${visibleSql(actor)}`,
    params,
  );
  const row = found.rows[0];
  if (!row) return null;
  const membership = row.owner_organization_id && actorUserId
    ? await activeMembership(client, actorUserId, row.owner_organization_id)
    : null;
  const projectVisible = row.design_project_id
    ? await projectVisibleTo(client, actorUserId, row.design_project_id)
    : false;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    method: row.method,
    visibility: row.visibility,
    access: accessFor(row, actorUserId, membership?.role ?? null),
    generated: false,
    referenceCount: Number(row.reference_count),
    updatedAt: new Date(row.updated_at).toISOString(),
    previewMediaId: row.preview_media_id,
    designProjectName: projectVisible ? row.project_name : null,
  };
}

async function loadConcept(
  client: PoolClient,
  actorUserId: string | null,
  conceptId: string,
): Promise<VisualizationConceptView | null> {
  const params: unknown[] = [conceptId];
  const actor = bind(params, actorUserId);
  const found = await client.query<ConceptRow>(
    `SELECT
       concept.id, concept.title, concept.notes, concept.status, concept.method, concept.visibility,
       concept.owner_user_id, concept.owner_organization_id, concept.design_project_id, concept.revision_id,
       concept.garment_id, concept.preview_media_id, concept.preview_origin, concept.created_at, concept.updated_at
     FROM visualization_concepts AS concept
     WHERE concept.id = $1 AND ${visibleSql(actor)}`,
    params,
  );
  const row = found.rows[0];
  if (!row) return null;
  const membership = row.owner_organization_id && actorUserId
    ? await activeMembership(client, actorUserId, row.owner_organization_id)
    : null;
  const references = await loadReferences(client, actorUserId, conceptId);
  const previewReference = references.find((item) => item.mediaId === row.preview_media_id) ?? null;
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    method: row.method,
    visibility: row.visibility,
    access: accessFor(row, actorUserId, membership?.role ?? null),
    generated: false,
    referenceCount: references.length,
    designProject: await loadProjectLink(client, actorUserId, row.design_project_id),
    revision: await loadRevisionLink(client, actorUserId, row.design_project_id, row.revision_id),
    garment: await loadGarmentLink(client, actorUserId, row.garment_id),
    preview: row.preview_media_id && row.preview_origin
      ? {
          mediaId: row.preview_media_id,
          origin: row.preview_origin,
          available: previewReference?.available ?? false,
          filename: previewReference?.filename ?? null,
        }
      : null,
    references,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function loadReferences(
  client: PoolClient,
  actorUserId: string | null,
  conceptId: string,
): Promise<VisualizationReferenceView[]> {
  const params: unknown[] = [conceptId];
  const actor = bind(params, actorUserId);
  const rows = await client.query<{
    media_id: string;
    position: number;
    origin: ReferenceOrigin;
    note: string;
    filename: string | null;
    mime_type: string | null;
    status: string | null;
    readable: boolean;
  }>(
    `SELECT
       ref.media_id, ref.position, ref.origin, ref.note,
       CASE WHEN ${mediaVisibleSql(actor)} THEN media.original_filename ELSE NULL END AS filename,
       CASE WHEN ${mediaVisibleSql(actor)} THEN media.mime_type ELSE NULL END AS mime_type,
       CASE WHEN ${mediaVisibleSql(actor)} THEN media.status ELSE NULL END AS status,
       ${mediaVisibleSql(actor)} AS readable
     FROM visualization_references AS ref
     JOIN media_assets AS media ON media.id = ref.media_id
     WHERE ref.concept_id = $1
     ORDER BY ref.position`,
    params,
  );
  return rows.rows.map((row) => ({
    mediaId: row.media_id,
    position: Number(row.position),
    origin: row.origin,
    note: row.note,
    available: row.readable && row.status === "ready",
    filename: row.readable ? row.filename : null,
    mimeType: row.readable ? row.mime_type : null,
    status: row.readable ? row.status : null,
  }));
}

async function loadProjectLink(
  client: PoolClient,
  actorUserId: string | null,
  projectId: string | null,
): Promise<VisualizationConceptView["designProject"]> {
  if (!projectId) return null;
  const params: unknown[] = [projectId];
  const actor = bind(params, actorUserId);
  const found = await client.query<{ name: string; status: string }>(
    `SELECT project.name, project.status
     FROM design_projects AS project
     WHERE project.id = $1 AND ${projectVisibleSql(actor)}`,
    params,
  );
  const row = found.rows[0];
  if (!row) return { id: projectId, available: false };
  return { id: projectId, name: row.name, status: row.status };
}

async function loadRevisionLink(
  client: PoolClient,
  actorUserId: string | null,
  projectId: string | null,
  revisionId: string | null,
): Promise<VisualizationConceptView["revision"]> {
  if (!revisionId) return null;
  if (!projectId) return { id: revisionId, available: false };
  const project = await loadProjectLink(client, actorUserId, projectId);
  if (!project || !("name" in project)) return { id: revisionId, available: false };
  const found = await client.query<{ revision_number: number }>(
    `SELECT revision_number FROM design_revisions WHERE id = $1 AND design_project_id = $2`,
    [revisionId, projectId],
  );
  const number = found.rows[0]?.revision_number;
  if (number == null) return { id: revisionId, available: false };
  return { id: revisionId, revisionNumber: Number(number) };
}

async function loadGarmentLink(
  client: PoolClient,
  actorUserId: string | null,
  garmentId: string | null,
): Promise<VisualizationConceptView["garment"]> {
  if (!garmentId) return null;
  try {
    const garment = await getCatalogGarment(client, actorUserId, garmentId);
    return {
      id: garment.id,
      name: garment.name,
      description: garment.description,
      garmentType: garment.garmentType,
      terms: garment.terms,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "not_found") {
      return { id: garmentId, available: false };
    }
    throw error;
  }
}

async function projectVisibleTo(client: PoolClient, actorUserId: string | null, projectId: string): Promise<boolean> {
  const link = await loadProjectLink(client, actorUserId, projectId);
  return Boolean(link && "name" in link);
}

async function lockConcept(client: PoolClient, conceptId: string): Promise<ConceptRow> {
  const found = await client.query<ConceptRow>(
    `SELECT
       id, title, notes, status, method, visibility, owner_user_id, owner_organization_id,
       design_project_id, revision_id, garment_id, preview_media_id, preview_origin, created_at, updated_at
     FROM visualization_concepts
     WHERE id = $1
     FOR UPDATE`,
    [conceptId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Visualization was not found.");
  return row;
}

async function assertCanEdit(client: PoolClient, actorUserId: string, concept: ConceptRow): Promise<void> {
  if (!(await canRead(client, actorUserId, concept))) throw notFound("Visualization was not found.");
  const allowed = await actorMayAccessOwner(
    client,
    actorUserId,
    ownerFromIds(concept.owner_user_id, concept.owner_organization_id),
  );
  if (!allowed) throw forbidden("You cannot change this visualization.");
}

async function assertCanManage(client: PoolClient, actorUserId: string, concept: ConceptRow): Promise<void> {
  if (concept.owner_user_id) {
    if (concept.owner_user_id !== actorUserId) throw forbidden("You cannot manage this visualization.");
    return;
  }
  if (!concept.owner_organization_id) throw forbidden("You cannot manage this visualization.");
  const membership = await activeMembership(client, actorUserId, concept.owner_organization_id);
  if (!membership) throw notFound("Visualization was not found.");
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw forbidden("Only an owner or admin can manage this visualization.");
  }
}

async function canRead(client: PoolClient, actorUserId: string | null, concept: ConceptRow): Promise<boolean> {
  if (concept.visibility === "public") return true;
  return actorMayAccessOwner(client, actorUserId, ownerFromIds(concept.owner_user_id, concept.owner_organization_id));
}

function accessFor(row: ConceptRow, actorUserId: string | null, role: string | null): VisualizationAccess {
  if (row.owner_user_id && actorUserId === row.owner_user_id) return "manage";
  if (role === "owner" || role === "admin") return "manage";
  if (role === "member") return "edit";
  return "view";
}

function assertOpen(status: VisualizationStatus) {
  if (status === "archived") throw invalid("invalid_status", "Reopen the concept before changing it.");
}

function isStatus(value: string): value is VisualizationStatus {
  return statuses.has(value as VisualizationStatus);
}

function cleanTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 160) throw invalid("invalid_title", "Concept title is required.");
  return trimmed;
}

function cleanNotes(notes: string | undefined): string {
  const trimmed = notes?.trim() ?? "";
  if (trimmed.length > 4000) throw invalid("invalid_notes", "Notes are too long.");
  return trimmed;
}

function cleanReferenceNote(note: string | undefined): string {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > 240) throw invalid("invalid_note", "Reference note is too long.");
  return trimmed;
}

function cleanMethod(method: string): VisualizationMethod {
  if (!methods.has(method as VisualizationMethod)) throw invalid("invalid_method", "Visualization method is not recognized.");
  return method as VisualizationMethod;
}

function visibleSql(actor: string): string {
  return `(
    concept.visibility = 'public'
    OR (${actor}::uuid IS NOT NULL AND concept.owner_user_id = ${actor}::uuid)
    OR (${actor}::uuid IS NOT NULL AND EXISTS (
      SELECT 1 FROM organization_memberships AS membership
      WHERE membership.organization_id = concept.owner_organization_id
        AND membership.user_id = ${actor}::uuid
        AND membership.status = 'active'
    ))
  )`;
}

function projectVisibleSql(actor: string): string {
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

function mediaVisibleSql(actor: string): string {
  return `(
    media.visibility = 'public'
    OR (${actor}::uuid IS NOT NULL AND media.owner_user_id = ${actor}::uuid)
    OR (${actor}::uuid IS NOT NULL AND EXISTS (
      SELECT 1 FROM organization_memberships AS membership
      WHERE membership.organization_id = media.owner_organization_id
        AND membership.user_id = ${actor}::uuid
        AND membership.status = 'active'
    ))
  )`;
}

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}
