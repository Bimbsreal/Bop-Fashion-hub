import type { PoolClient } from "pg";
import { actorMayAccessOwner, assertCanActForOwner, ownerColumns, ownerFromIds, type OwnerRef } from "./access";
import { invalid, notFound } from "../errors";
import { replaceSizeLabels, type SizeLabelRef } from "./measurements";

export type GarmentRecord = {
  id: string;
  name: string;
  owner_user_id: string | null;
  owner_organization_id: string | null;
};

export async function createGarment(
  client: PoolClient,
  actorUserId: string,
  input: { owner: OwnerRef; name: string; description?: string; termSlugs?: string[] },
): Promise<GarmentRecord> {
  await assertCanActForOwner(client, actorUserId, input.owner);
  const name = input.name.trim();
  if (!name) throw invalid("invalid_name", "Garment name is required.");

  const columns = ownerColumns(input.owner);
  const inserted = await client.query<GarmentRecord>(
    `INSERT INTO garments (owner_user_id, owner_organization_id, name, description, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, owner_user_id, owner_organization_id`,
    [columns.ownerUserId, columns.ownerOrganizationId, name, input.description?.trim() ?? "", actorUserId],
  );
  const garment = inserted.rows[0];
  if (!garment) throw invalid("invalid_name", "Garment name is required.");

  const slugs = [...new Set((input.termSlugs ?? []).map((slug) => slug.trim()).filter(Boolean))];
  if (slugs.length > 0) {
    const found = await client.query<{ slug: string }>(
      `SELECT slug FROM fashion_terms WHERE slug = ANY($1::text[])`,
      [slugs],
    );
    if (found.rows.length !== slugs.length) {
      throw invalid("unknown_term", "One or more fashion terms were not found.");
    }
    await client.query(
      `INSERT INTO garment_terms (garment_id, term_id)
       SELECT $1, id FROM fashion_terms WHERE slug = ANY($2::text[])`,
      [garment.id, slugs],
    );
  }

  return garment;
}

export async function setGarmentType(
  client: PoolClient,
  actorUserId: string,
  garmentId: string,
  typeSlug: string,
): Promise<void> {
  const garment = await client.query<GarmentRecord>(
    `SELECT id, name, owner_user_id, owner_organization_id FROM garments WHERE id = $1`,
    [garmentId],
  );
  const row = garment.rows[0];
  if (!row) throw invalid("not_found", "Garment was not found.");
  await assertCanActForOwner(
    client,
    actorUserId,
    ownerFromIds(row.owner_user_id, row.owner_organization_id),
  );

  const term = await client.query<{ id: string }>(
    `SELECT id FROM fashion_terms WHERE kind = 'garment_type' AND slug = $1`,
    [typeSlug],
  );
  const typeId = term.rows[0]?.id;
  if (!typeId) throw invalid("unknown_term", "Garment type was not found.");

  await client.query(`UPDATE garments SET garment_type_id = $2 WHERE id = $1`, [garmentId, typeId]);
  await client.query(
    `INSERT INTO garment_terms (garment_id, term_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [garmentId, typeId],
  );
}

export type TermRef = { kind: string; slug: string };
export type CatalogAccess = "view" | "edit";

export type GarmentView = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  access: CatalogAccess;
  garmentType: TermView | null;
  terms: TermView[];
  sizeLabels: SizeLabelRef[];
  measurements: {
    definition: string;
    unit: string;
    value: string;
    enteredValue: string;
    enteredUnit: string;
    sizeLabel: string | null;
    provenance: string;
  }[];
  media: {
    id: string;
    role: string;
    mediaType: string;
    mimeType: string;
    storageKey?: string;
  }[];
  createdBy: { displayName: string } | null;
  organization: { name: string; slug: string; kind: string } | null;
  createdAt: string;
  updatedAt: string;
};

type TermView = { kind: string; slug: string; name: string };

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const termKinds = new Set([
  "garment_type",
  "material",
  "pattern",
  "style",
  "category",
  "tradition",
  "color",
  "silhouette",
  "sleeve",
  "neckline",
  "length",
  "closure",
  "occasion",
  "season",
  "fit_preference",
]);

export async function createCatalogGarment(
  client: PoolClient,
  actorUserId: string,
  input: {
    owner: OwnerRef;
    name: string;
    description?: string;
    visibility?: string;
    terms?: TermRef[];
    sizeLabels?: SizeLabelRef[];
  },
): Promise<GarmentView> {
  await assertCanActForOwner(client, actorUserId, input.owner);
  if (input.owner.organizationId) {
    const organization = await client.query<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [input.owner.organizationId],
    );
    if (organization.rows[0]?.status !== "active") throw invalid("invalid_owner", "Organization is not active.");
  }

  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  const visibility = cleanVisibility(input.visibility ?? "private");
  const columns = ownerColumns(input.owner);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO garments (
       owner_user_id, owner_organization_id, name, description, created_by_user_id, visibility
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [columns.ownerUserId, columns.ownerOrganizationId, name, description, actorUserId, visibility],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_name", "Garment name is required.");
  if (input.terms) await replaceGarmentTerms(client, actorUserId, id, input.terms);
  if (input.sizeLabels) await replaceSizeLabels(client, actorUserId, id, input.sizeLabels);
  return getCatalogGarment(client, actorUserId, id);
}

export async function updateCatalogGarment(
  client: PoolClient,
  actorUserId: string,
  garmentId: string,
  input: {
    name?: string;
    description?: string;
    visibility?: string;
    terms?: TermRef[];
    sizeLabels?: SizeLabelRef[];
  },
): Promise<GarmentView> {
  if (
    input.name === undefined &&
    input.description === undefined &&
    input.visibility === undefined &&
    input.terms === undefined &&
    input.sizeLabels === undefined
  ) {
    throw invalid("invalid_body", "No garment changes were provided.");
  }

  const existing = await lockGarment(client, garmentId);
  const allowed = await actorMayAccessOwner(client, actorUserId, ownerFromIds(existing.owner_user_id, existing.owner_organization_id));
  if (!allowed) throw notFound("Garment was not found.");

  const name = input.name === undefined ? existing.name : cleanName(input.name);
  const description = input.description === undefined ? existing.description : cleanDescription(input.description);
  const visibility = input.visibility === undefined ? existing.visibility : cleanVisibility(input.visibility);
  await client.query(
    `UPDATE garments SET name = $2, description = $3, visibility = $4 WHERE id = $1`,
    [garmentId, name, description, visibility],
  );
  if (input.terms) await replaceGarmentTerms(client, actorUserId, garmentId, input.terms);
  if (input.sizeLabels) await replaceSizeLabels(client, actorUserId, garmentId, input.sizeLabels);
  return getCatalogGarment(client, actorUserId, garmentId);
}

export async function getCatalogGarment(
  client: PoolClient,
  actorUserId: string | null,
  garmentId: string,
): Promise<GarmentView> {
  const loaded = await loadGarments(client, actorUserId, [garmentId]);
  const garment = loaded[0];
  if (!garment) throw notFound("Garment was not found.");
  return garment;
}

export async function listCatalogGarments(
  client: PoolClient,
  actorUserId: string | null,
  query: {
    limit: number;
    offset: number;
    type?: string;
    category?: string;
    material?: string;
    pattern?: string;
    style?: string;
    color?: string;
    visibility?: string;
  },
): Promise<{ garments: GarmentView[]; total: number }> {
  const params: unknown[] = [];
  const actor = bind(params, actorUserId);
  const where = [
    `(
      g.visibility = 'public'
      OR (${actor}::uuid IS NOT NULL AND g.owner_user_id = ${actor}::uuid)
      OR (${actor}::uuid IS NOT NULL AND EXISTS (
        SELECT 1 FROM organization_memberships AS membership
        WHERE membership.organization_id = g.owner_organization_id
          AND membership.user_id = ${actor}::uuid
          AND membership.status = 'active'
      ))
    )`,
  ];
  const termFilter = (kind: string, slug: string | undefined) => {
    if (!slug) return;
    const kindPlaceholder = bind(params, kind);
    const slugPlaceholder = bind(params, slug);
    where.push(`EXISTS (
      SELECT 1 FROM garment_terms
      JOIN fashion_terms ON fashion_terms.id = garment_terms.term_id
      WHERE garment_terms.garment_id = g.id
        AND fashion_terms.kind = ${kindPlaceholder}
        AND fashion_terms.slug = ${slugPlaceholder}
    )`);
  };
  if (query.type) {
    const placeholder = bind(params, query.type);
    where.push(`EXISTS (
      SELECT 1 FROM fashion_terms
      WHERE fashion_terms.id = g.garment_type_id
        AND fashion_terms.kind = 'garment_type'
        AND fashion_terms.slug = ${placeholder}
    )`);
  }
  termFilter("category", query.category);
  termFilter("material", query.material);
  termFilter("pattern", query.pattern);
  termFilter("style", query.style);
  termFilter("color", query.color);
  if (query.visibility) where.push(`g.visibility = ${bind(params, query.visibility)}`);

  const whereSql = where.join(" AND ");
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM garments AS g WHERE ${whereSql}`,
    params,
  );
  const pageParams = [...params];
  const limit = bind(pageParams, query.limit);
  const offset = bind(pageParams, query.offset);
  const page = await client.query<{ id: string }>(
    `SELECT g.id
     FROM garments AS g
     WHERE ${whereSql}
     ORDER BY g.created_at DESC, g.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    pageParams,
  );
  const garments = await loadGarments(client, actorUserId, page.rows.map((row) => row.id));
  return { garments, total: Number(total.rows[0]?.total ?? 0) };
}

async function replaceGarmentTerms(
  client: PoolClient,
  actorUserId: string,
  garmentId: string,
  terms: TermRef[],
): Promise<void> {
  const existing = await lockGarment(client, garmentId);
  const allowed = await actorMayAccessOwner(client, actorUserId, ownerFromIds(existing.owner_user_id, existing.owner_organization_id));
  if (!allowed) throw notFound("Garment was not found.");
  const normalized = normalizeTerms(terms);
  const typeTerms = normalized.filter((term) => term.kind === "garment_type");
  if (typeTerms.length > 1) throw invalid("invalid_type", "A garment can have only one garment type.");

  let typeId: string | null = null;
  await client.query(`DELETE FROM garment_terms WHERE garment_id = $1`, [garmentId]);
  if (normalized.length > 0) {
    const params: unknown[] = [];
    const clauses = normalized.map((term) => {
      const kind = bind(params, term.kind);
      const slug = bind(params, term.slug);
      return `(kind = ${kind} AND slug = ${slug})`;
    });
    const found = await client.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM fashion_terms WHERE ${clauses.join(" OR ")}`,
      params,
    );
    if (found.rows.length !== normalized.length) {
      throw invalid("unknown_term", "One or more fashion terms were not found.");
    }
    const insertParams: unknown[] = [garmentId];
    const insertClauses = normalized.map((term) => {
      const kind = bind(insertParams, term.kind);
      const slug = bind(insertParams, term.slug);
      return `(kind = ${kind} AND slug = ${slug})`;
    });
    await client.query(
      `INSERT INTO garment_terms (garment_id, term_id)
       SELECT $1, id FROM fashion_terms WHERE ${insertClauses.join(" OR ")}`,
      insertParams,
    );
    typeId = found.rows.find((row) => row.kind === "garment_type")?.id ?? null;
  }
  await client.query(`UPDATE garments SET garment_type_id = $2 WHERE id = $1`, [garmentId, typeId]);
}

async function loadGarments(
  client: PoolClient,
  actorUserId: string | null,
  ids: string[],
): Promise<GarmentView[]> {
  if (ids.length === 0) return [];
  const rows = await client.query<GarmentRow>(
    `SELECT
       g.id, g.name, g.description, g.visibility, g.owner_user_id, g.owner_organization_id,
       g.created_at, g.updated_at,
       creator.display_name AS creator_name,
       org.name AS organization_name, org.slug AS organization_slug, org.kind AS organization_kind,
       type_term.kind AS type_kind, type_term.slug AS type_slug, type_term.name AS type_name
     FROM garments AS g
     LEFT JOIN users AS creator ON creator.id = g.created_by_user_id
     LEFT JOIN organizations AS org ON org.id = g.owner_organization_id
     LEFT JOIN fashion_terms AS type_term ON type_term.id = g.garment_type_id
     WHERE g.id = ANY($1::uuid[])
       AND (
         g.visibility = 'public'
         OR ($2::uuid IS NOT NULL AND g.owner_user_id = $2::uuid)
         OR ($2::uuid IS NOT NULL AND EXISTS (
           SELECT 1 FROM organization_memberships AS membership
           WHERE membership.organization_id = g.owner_organization_id
             AND membership.user_id = $2::uuid
             AND membership.status = 'active'
         ))
       )`,
    [ids, actorUserId],
  );
  const visible = new Map(rows.rows.map((row) => [row.id, row]));
  const ordered = ids.flatMap((id) => {
    const row = visible.get(id);
    return row ? [row] : [];
  });
  if (ordered.length === 0) return [];

  const visibleIds = ordered.map((row) => row.id);
  const terms = await client.query<TermView & { garment_id: string }>(
    `SELECT garment_terms.garment_id, fashion_terms.kind, fashion_terms.slug, fashion_terms.name
     FROM garment_terms
     JOIN fashion_terms ON fashion_terms.id = garment_terms.term_id
     WHERE garment_terms.garment_id = ANY($1::uuid[])
     ORDER BY fashion_terms.kind, fashion_terms.slug`,
    [visibleIds],
  );
  const labels = await client.query<SizeLabelRef & { garment_id: string }>(
    `SELECT garment_size_labels.garment_id, size_systems.slug AS system, size_labels.label
     FROM garment_size_labels
     JOIN size_labels ON size_labels.id = garment_size_labels.size_label_id
     JOIN size_systems ON size_systems.id = size_labels.size_system_id
     WHERE garment_size_labels.garment_id = ANY($1::uuid[])
     ORDER BY size_systems.slug, size_labels.label`,
    [visibleIds],
  );
  const measurements = await client.query<{
    garment_id: string;
    definition: string;
    unit: string;
    value: string;
    entered_value: string;
    entered_unit: string;
    size_label: string | null;
    provenance: string;
  }>(
    `SELECT garment_measurements.garment_id, measurement_definitions.slug AS definition,
            measurement_definitions.unit, garment_measurements.value::text AS value,
            garment_measurements.entered_value::text AS entered_value,
            garment_measurements.entered_unit,
            size_labels.label AS size_label, garment_measurements.provenance
     FROM garment_measurements
     JOIN measurement_definitions ON measurement_definitions.id = garment_measurements.definition_id
     LEFT JOIN size_labels ON size_labels.id = garment_measurements.size_label_id
     WHERE garment_measurements.garment_id = ANY($1::uuid[])
     ORDER BY measurement_definitions.slug, size_labels.label`,
    [visibleIds],
  );
  const media = await client.query<{
    garment_id: string;
    id: string;
    role: string;
    media_type: string;
    mime_type: string;
    storage_key: string;
  }>(
    `SELECT garment_media.garment_id, media_assets.id, garment_media.role,
            media_assets.media_type, media_assets.mime_type, media_assets.storage_key
     FROM garment_media
     JOIN media_assets ON media_assets.id = garment_media.media_id
     WHERE garment_media.garment_id = ANY($1::uuid[])
     ORDER BY garment_media.role`,
    [visibleIds],
  );
  const memberships = actorUserId
    ? await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM organization_memberships
         WHERE user_id = $1 AND status = 'active'`,
        [actorUserId],
      )
    : { rows: [] as { organization_id: string }[] };
  const memberOrgs = new Set(memberships.rows.map((row) => row.organization_id));

  return ordered.map((row) => {
    const access: CatalogAccess =
      (actorUserId && row.owner_user_id === actorUserId) ||
      (row.owner_organization_id !== null && memberOrgs.has(row.owner_organization_id))
        ? "edit"
        : "view";
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      access,
      garmentType: row.type_slug && row.type_kind && row.type_name
        ? { kind: row.type_kind, slug: row.type_slug, name: row.type_name }
        : null,
      terms: terms.rows.filter((term) => term.garment_id === row.id).map(({ kind, slug, name }) => ({ kind, slug, name })),
      sizeLabels: labels.rows.filter((label) => label.garment_id === row.id).map(({ system, label }) => ({ system, label })),
      measurements: measurements.rows
        .filter((measurement) => measurement.garment_id === row.id)
        .map((measurement) => ({
          definition: measurement.definition,
          unit: measurement.unit,
          value: measurement.value,
          enteredValue: trimNumeric(measurement.entered_value),
          enteredUnit: measurement.entered_unit,
          sizeLabel: measurement.size_label,
          provenance: measurement.provenance,
        })),
      media: media.rows
        .filter((item) => item.garment_id === row.id)
        .map((item) => ({
          id: item.id,
          role: item.role,
          mediaType: item.media_type,
          mimeType: item.mime_type,
          ...(access === "edit" ? { storageKey: item.storage_key } : {}),
        })),
      createdBy: row.creator_name ? { displayName: row.creator_name } : null,
      organization:
        row.organization_name && row.organization_slug && row.organization_kind
          ? { name: row.organization_name, slug: row.organization_slug, kind: row.organization_kind }
          : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}

type GarmentRow = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  owner_user_id: string | null;
  owner_organization_id: string | null;
  created_at: Date;
  updated_at: Date;
  creator_name: string | null;
  organization_name: string | null;
  organization_slug: string | null;
  organization_kind: string | null;
  type_kind: string | null;
  type_slug: string | null;
  type_name: string | null;
};

async function lockGarment(client: PoolClient, garmentId: string): Promise<GarmentRow> {
  const result = await client.query<GarmentRow>(
    `SELECT
       g.id, g.name, g.description, g.visibility, g.owner_user_id, g.owner_organization_id,
       g.created_at, g.updated_at,
       NULL::text AS creator_name, NULL::text AS organization_name,
       NULL::text AS organization_slug, NULL::text AS organization_kind,
       NULL::text AS type_kind, NULL::text AS type_slug, NULL::text AS type_name
     FROM garments AS g
     WHERE g.id = $1
     FOR UPDATE`,
    [garmentId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Garment was not found.");
  return row;
}

function normalizeTerms(terms: TermRef[]): TermRef[] {
  const seen = new Set<string>();
  const normalized: TermRef[] = [];
  for (const term of terms) {
    const kind = term.kind.trim();
    const slug = term.slug.trim().toLowerCase();
    if (!termKinds.has(kind) || !slugPattern.test(slug)) {
      throw invalid("unknown_term", "One or more fashion terms were not found.");
    }
    const key = `${kind}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ kind, slug });
  }
  return normalized;
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 160) throw invalid("invalid_name", "Garment name is required.");
  return trimmed;
}

function cleanDescription(description: string | undefined): string {
  const trimmed = description?.trim() ?? "";
  if (trimmed.length > 8000) throw invalid("invalid_description", "Description is too long.");
  return trimmed;
}

function cleanVisibility(visibility: string): "private" | "public" {
  if (visibility !== "private" && visibility !== "public") {
    throw invalid("invalid_visibility", "Visibility must be private or public.");
  }
  return visibility;
}

function trimNumeric(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

function bind(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}
