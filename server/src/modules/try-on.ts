import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { actorMayAccessOwner, assertCanActForOwner, ownerColumns, ownerFromIds, type OwnerRef } from "./access";
import { invalid, notFound } from "../errors";
import { requireProject } from "./design";
import { getCatalogGarment } from "./fashion";
import { requireMedia } from "./uploads";
import { requireVisualization } from "./visualization";

const presentations = new Set(["catalog", "worn", "flat_lay", "mannequin"]);
const imageMimes = new Set(["image/jpeg", "image/png", "image/webp"]);
const blockedGarmentRoles = new Set(["sketch", "fabric", "generated", "construction"]);
const consentPurpose = "try_on_request";
const unavailableMessage = "Virtual try-on is not configured. No image was generated.";

export type TryOnLimits = { maxBytes: number; maxEdge: number; minEdge: number };

export type TryOnView = {
  id: string;
  status: "draft" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  operational: false;
  configured: false;
  simulated: false;
  generated: false;
  fitClaim: false;
  output: null;
  message: string;
  garmentCategory: string;
  garmentPresentation: string;
  personMedia: { id: string; filename: string | null };
  garment: { id: string; name: string | null };
  garmentMedia: { id: string; filename: string | null };
  designProjectId: string | null;
  revisionId: string | null;
  visualizationId: string | null;
  consent: { purpose: "try_on_request"; consentedAt: string };
  createdAt: string;
  updatedAt: string;
};

type RequestRow = {
  id: string;
  status: TryOnView["status"];
  garment_category: string;
  garment_presentation: string;
  person_media_id: string;
  garment_id: string;
  garment_media_id: string;
  design_project_id: string | null;
  revision_id: string | null;
  visualization_id: string | null;
  consent_purpose: "try_on_request";
  consented_at: Date;
  created_at: Date;
  updated_at: Date;
  owner_user_id: string | null;
  owner_organization_id: string | null;
  input_fingerprint: string;
};

export function tryOnCapability(limits: TryOnLimits) {
  return {
    id: "fashion.virtual_try_on",
    registered: true,
    configured: false,
    operational: false,
    simulated: false,
    supportedCategories: [] as string[],
    fitClaim: false,
    message: unavailableMessage,
    input: {
      formats: ["image/jpeg", "image/png", "image/webp"],
      maxBytes: limits.maxBytes,
      maxEdge: limits.maxEdge,
      minEdge: limits.minEdge,
      consentPurpose,
      garmentPresentations: ["catalog", "worn", "flat_lay", "mannequin"],
      rejectedGarmentRoles: ["sketch", "fabric", "generated", "construction"],
    },
  };
}

export async function createTryOnRequest(
  client: PoolClient,
  actorUserId: string,
  input: {
    owner: OwnerRef;
    personMediaId: string;
    garmentId: string;
    garmentMediaId: string;
    garmentPresentation: string;
    designProjectId?: string | null;
    revisionId?: string | null;
    visualizationId?: string | null;
    consentPurpose?: string;
    idempotencyKey: string | null;
  },
  limits: TryOnLimits,
): Promise<{ request: TryOnView; replayed: boolean }> {
  if (input.consentPurpose !== consentPurpose) {
    throw invalid("consent_required", "Confirm this image may be used for this try-on request only.");
  }
  if (!presentations.has(input.garmentPresentation)) {
    throw invalid("invalid_presentation", "That garment presentation is not accepted.");
  }
  if (input.personMediaId === input.garmentMediaId) {
    throw invalid("invalid_media", "The person image and the garment image must be different.");
  }
  if (input.owner.organizationId) {
    const organization = await client.query<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [input.owner.organizationId],
    );
    if (organization.rows[0]?.status !== "active") throw invalid("invalid_owner", "Organization is not active.");
  }
  await assertCanActForOwner(client, actorUserId, input.owner);
  await assertTryOnImage(client, actorUserId, input.personMediaId, limits, "person");
  const garment = await getCatalogGarment(client, actorUserId, input.garmentId);
  const category = garment.garmentType?.slug;
  if (!category) throw invalid("unsupported_category", "Choose a garment with a catalog type.");
  await assertGarmentImage(client, actorUserId, input.garmentId, input.garmentMediaId, limits);
  if (input.designProjectId) await requireProject(client, actorUserId, input.designProjectId);
  if (input.revisionId) await assertRevision(client, input.revisionId, input.designProjectId ?? null);
  if (input.visualizationId) await requireVisualization(client, actorUserId, input.visualizationId);

  const fingerprint = fingerprintFor(input, category);
  if (input.idempotencyKey) {
    const existing = await findByIdempotency(client, actorUserId, input.idempotencyKey);
    if (existing) {
      if (existing.input_fingerprint !== fingerprint) throw invalid("conflict", "Idempotency key was already used.");
      const view = await requireTryOnRequest(client, actorUserId, existing.id);
      return { request: view, replayed: true };
    }
  }

  const columns = ownerColumns(input.owner);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO try_on_requests (
       owner_user_id, owner_organization_id, created_by_user_id,
       person_media_id, garment_id, garment_media_id, garment_category, garment_presentation,
       design_project_id, revision_id, visualization_id, consent_purpose, input_fingerprint, idempotency_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      columns.ownerUserId,
      columns.ownerOrganizationId,
      actorUserId,
      input.personMediaId,
      input.garmentId,
      input.garmentMediaId,
      category,
      input.garmentPresentation,
      input.designProjectId ?? null,
      input.revisionId ?? null,
      input.visualizationId ?? null,
      consentPurpose,
      fingerprint,
      input.idempotencyKey,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_body", "Try-on request could not be saved.");
  return { request: await requireTryOnRequest(client, actorUserId, id), replayed: false };
}

export async function listTryOnRequests(
  client: PoolClient,
  actorUserId: string | null,
  query: { limit: number; offset: number },
): Promise<{ requests: TryOnView[]; total: number }> {
  const params: unknown[] = [];
  const actor = bind(params, actorUserId);
  const where = visibleSql(actor);
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM try_on_requests AS request WHERE ${where}`,
    params,
  );
  const pageParams = [...params];
  const limit = bind(pageParams, query.limit);
  const offset = bind(pageParams, query.offset);
  const page = await client.query<{ id: string }>(
    `SELECT request.id FROM try_on_requests AS request
     WHERE ${where}
     ORDER BY request.created_at DESC, request.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    pageParams,
  );
  const requests: TryOnView[] = [];
  for (const row of page.rows) {
    const request = await loadRequest(client, actorUserId, row.id);
    if (request) requests.push(request);
  }
  return { requests, total: Number(total.rows[0]?.total ?? 0) };
}

export async function requireTryOnRequest(
  client: PoolClient,
  actorUserId: string | null,
  requestId: string,
): Promise<TryOnView> {
  const request = await loadRequest(client, actorUserId, requestId);
  if (!request) throw notFound("Try-on request was not found.");
  return request;
}

export async function cancelTryOnRequest(
  client: PoolClient,
  actorUserId: string,
  requestId: string,
): Promise<TryOnView> {
  const current = await lockRequest(client, requestId);
  if (!(await canRead(client, actorUserId, current))) throw notFound("Try-on request was not found.");
  const allowed = await actorMayAccessOwner(
    client,
    actorUserId,
    ownerFromIds(current.owner_user_id, current.owner_organization_id),
  );
  if (!allowed) throw invalid("forbidden", "You cannot change this try-on request.");
  if (current.status === "cancelled") return requireTryOnRequest(client, actorUserId, requestId);
  if (current.status !== "draft") throw invalid("cancel_unsupported", "This try-on request cannot be cancelled.");
  await client.query(`UPDATE try_on_requests SET status = 'cancelled' WHERE id = $1`, [requestId]);
  return requireTryOnRequest(client, actorUserId, requestId);
}

async function assertTryOnImage(
  client: PoolClient,
  actorUserId: string,
  mediaId: string,
  limits: TryOnLimits,
  kind: "person" | "garment",
) {
  const media = await requireMedia(client, actorUserId, mediaId);
  if (media.variant !== "original" || media.status !== "ready" || media.mediaType !== "image") {
    throw invalid("invalid_media", "Use a ready original image.");
  }
  if (!imageMimes.has(media.mimeType)) throw invalid("invalid_media", "Use a JPEG, PNG, or WebP image.");
  if (media.byteSize > limits.maxBytes || (media.widthPx ?? 0) > limits.maxEdge || (media.heightPx ?? 0) > limits.maxEdge) {
    throw invalid("invalid_media", kind === "person" ? "The person image is too large." : "The garment image is too large.");
  }
  if (media.widthPx == null || media.heightPx == null) {
    throw invalid("invalid_media", "This image has no recorded dimensions.");
  }
  if (Math.min(media.widthPx, media.heightPx) < limits.minEdge) {
    throw invalid("invalid_media", "This image is too small for try-on.");
  }
}

async function assertGarmentImage(
  client: PoolClient,
  actorUserId: string,
  garmentId: string,
  mediaId: string,
  limits: TryOnLimits,
) {
  await assertTryOnImage(client, actorUserId, mediaId, limits, "garment");
  const link = await client.query<{ role: string }>(
    `SELECT role FROM garment_media WHERE garment_id = $1 AND media_id = $2`,
    [garmentId, mediaId],
  );
  const role = link.rows[0]?.role;
  if (!role) throw invalid("invalid_garment", "That image is not linked to this garment.");
  if (blockedGarmentRoles.has(role)) {
    throw invalid("unsupported_garment", "Sketches, swatches, construction drawings, and generated images cannot be tried on.");
  }
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

async function findByIdempotency(client: PoolClient, actorUserId: string, key: string): Promise<RequestRow | null> {
  const found = await client.query<RequestRow>(
    `SELECT ${rowColumns} FROM try_on_requests AS request WHERE created_by_user_id = $1 AND idempotency_key = $2`,
    [actorUserId, key],
  );
  return found.rows[0] ?? null;
}

async function loadRequest(client: PoolClient, actorUserId: string | null, requestId: string): Promise<TryOnView | null> {
  const params: unknown[] = [requestId];
  const actor = bind(params, actorUserId);
  const found = await client.query<RequestRow>(
    `SELECT ${rowColumns}
     FROM try_on_requests AS request
     WHERE request.id = $1 AND ${visibleSql(actor)}`,
    params,
  );
  const row = found.rows[0];
  if (!row) return null;
  const person = await mediaName(client, actorUserId, row.person_media_id);
  const garmentMedia = await mediaName(client, actorUserId, row.garment_media_id);
  let garmentName: string | null = null;
  try {
    garmentName = (await getCatalogGarment(client, actorUserId, row.garment_id)).name;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as { code: string }).code !== "not_found") throw error;
  }
  return {
    id: row.id,
    status: row.status,
    operational: false,
    configured: false,
    simulated: false,
    generated: false,
    fitClaim: false,
    output: null,
    message: row.status === "cancelled" ? "This request was cancelled. No image was generated." : unavailableMessage,
    garmentCategory: row.garment_category,
    garmentPresentation: row.garment_presentation,
    personMedia: { id: row.person_media_id, filename: person },
    garment: { id: row.garment_id, name: garmentName },
    garmentMedia: { id: row.garment_media_id, filename: garmentMedia },
    designProjectId: row.design_project_id,
    revisionId: row.revision_id,
    visualizationId: row.visualization_id,
    consent: { purpose: row.consent_purpose, consentedAt: new Date(row.consented_at).toISOString() },
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function mediaName(client: PoolClient, actorUserId: string | null, mediaId: string): Promise<string | null> {
  try {
    const media = await requireMedia(client, actorUserId, mediaId);
    return media.originalFilename || null;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "not_found") return null;
    throw error;
  }
}

async function lockRequest(client: PoolClient, requestId: string): Promise<RequestRow> {
  const found = await client.query<RequestRow>(
    `SELECT ${rowColumns} FROM try_on_requests AS request WHERE request.id = $1 FOR UPDATE`,
    [requestId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Try-on request was not found.");
  return row;
}

async function canRead(client: PoolClient, actorUserId: string | null, row: RequestRow): Promise<boolean> {
  return actorMayAccessOwner(client, actorUserId, ownerFromIds(row.owner_user_id, row.owner_organization_id));
}

function fingerprintFor(
  input: {
    personMediaId: string;
    garmentId: string;
    garmentMediaId: string;
    garmentPresentation: string;
    designProjectId?: string | null;
    revisionId?: string | null;
    visualizationId?: string | null;
  },
  category: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        personMediaId: input.personMediaId,
        garmentId: input.garmentId,
        garmentMediaId: input.garmentMediaId,
        garmentPresentation: input.garmentPresentation,
        category,
        designProjectId: input.designProjectId ?? null,
        revisionId: input.revisionId ?? null,
        visualizationId: input.visualizationId ?? null,
        consent: consentPurpose,
      }),
    )
    .digest("hex");
}

const rowColumns = `
  request.id, request.status, request.garment_category, request.garment_presentation,
  request.person_media_id, request.garment_id, request.garment_media_id,
  request.design_project_id, request.revision_id, request.visualization_id,
  request.consent_purpose, request.consented_at, request.created_at, request.updated_at,
  request.owner_user_id, request.owner_organization_id, request.input_fingerprint
`;

function visibleSql(actor: string): string {
  return `(
    ${actor}::uuid IS NOT NULL AND request.owner_user_id = ${actor}::uuid
    OR (${actor}::uuid IS NOT NULL AND EXISTS (
      SELECT 1 FROM organization_memberships AS membership
      WHERE membership.organization_id = request.owner_organization_id
        AND membership.user_id = ${actor}::uuid
        AND membership.status = 'active'
    ))
  )`;
}

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}
