import type { PoolClient } from "pg";
import { actorMayAccessOwner, ownerFromIds } from "./access";
import { invalid, notFound } from "../errors";
import { requireTask, type TaskView } from "./ai-tasks";

export const analysisSchemaVersion = "garment-attributes.v1";
export const extractionCapability = "fashion.garment_attribute_extraction";

const attributeKeys = [
  "primary_type",
  "secondary_type",
  "category",
  "subcategory",
  "item_count",
  "dominant_colors",
  "secondary_colors",
  "pattern",
  "decorative_details",
  "embellishments",
  "texture",
  "silhouette",
  "length",
  "sleeve",
  "neckline",
  "layering",
  "construction",
  "style",
  "occasion",
  "tradition",
  "apparent_material",
  "weave",
  "sheen",
  "drape",
  "tags",
] as const;

const listKeys = new Set(["dominant_colors", "secondary_colors", "tags"]);
const countKeys = new Set(["item_count"]);
const catalogKind: Record<string, string | null> = {
  primary_type: "garment_type",
  category: "category",
  pattern: "pattern",
  style: "style",
  tradition: "tradition",
  dominant_colors: "color",
  secondary_colors: "color",
  silhouette: "silhouette",
  length: "length",
  sleeve: "sleeve",
  neckline: "neckline",
  occasion: "occasion",
};

const blockedKeys = new Set(["person", "face", "age", "ethnicity", "race", "identity", "health"]);
const fixtureNote = "Simulated fixture. This was not read from the image.";

export type AnalysisAttribute = {
  key: string;
  value: string | number | string[] | null;
  basis: "observed" | "inferred" | "unknown";
  note: string;
  confidence: number | null;
  confidenceSource: "provider" | null;
  reviewStatus: "pending" | "accepted" | "rejected" | "corrected";
  fiberEstablished: false;
};

type StoredAttribute = AnalysisAttribute;

export type AnalysisView = {
  id: string;
  taskId: string;
  mediaId: string;
  schemaVersion: string;
  simulated: boolean;
  operational: false;
  providerId: string;
  modelId: string | null;
  status: string;
  error: TaskView["error"];
  summary: string | null;
  attributes: AnalysisAttribute[];
  applications: { garmentId: string; applied: unknown; skipped: unknown; createdAt: string }[];
  createdAt: string;
};

export function emptyAnalysisDocument(): { attributes: Record<string, unknown> } {
  const attributes: Record<string, unknown> = {};
  for (const key of attributeKeys) attributes[key] = { value: null, basis: "unknown", note: "" };
  return { attributes };
}

export function fixtureAnalysisDocument(): { attributes: Record<string, unknown> } {
  const document = emptyAnalysisDocument();
  const inferred = (value: string | number | string[]) => ({ value, basis: "inferred", note: fixtureNote });
  document.attributes.primary_type = inferred("agbada");
  document.attributes.pattern = inferred("geometric");
  document.attributes.style = inferred("contemporary-african");
  document.attributes.item_count = inferred(1);
  document.attributes.dominant_colors = inferred(["indigo", "gold"]);
  return document;
}

export function parseGarmentAnalysis(document: unknown): { ok: true; attributes: StoredAttribute[] } | { ok: false; message: string } {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, message: "The analysis result did not match the schema." };
  }
  const record = document as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (blockedKeys.has(key)) return { ok: false, message: "The analysis result did not match the schema." };
  }
  if (Object.keys(record).some((key) => key !== "attributes")) {
    return { ok: false, message: "The analysis result did not match the schema." };
  }
  const source = record.attributes;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, message: "The analysis result did not match the schema." };
  }
  const attributes: StoredAttribute[] = [];
  for (const key of Object.keys(source)) {
    if (!attributeKeys.includes(key as (typeof attributeKeys)[number])) {
      return { ok: false, message: "The analysis result did not match the schema." };
    }
  }
  for (const key of attributeKeys) {
    const raw = (source as Record<string, unknown>)[key];
    if (raw === undefined) {
      attributes.push(unknownAttribute(key));
      continue;
    }
    const parsed = parseAttribute(key, raw, "provider");
    if (!parsed.ok) return parsed;
    attributes.push(parsed.attribute);
  }
  return { ok: true, attributes };
}

export function parseCorrection(key: string, value: unknown, basis: unknown, note: unknown): StoredAttribute {
  const parsed = parseAttribute(key, { value, basis, note }, "review");
  if (!parsed.ok) throw invalid("invalid_attribute", parsed.message);
  return { ...parsed.attribute, reviewStatus: "corrected" };
}

export async function createAnalysisShell(
  client: PoolClient,
  input: { taskId: string; mediaId: string; providerId: string; simulated: boolean },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO garment_analyses (task_id, media_id, schema_version, simulated, provider_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (task_id) DO UPDATE SET media_id = garment_analyses.media_id
     RETURNING id`,
    [input.taskId, input.mediaId, analysisSchemaVersion, input.simulated, input.providerId],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_body", "Analysis could not be saved.");
  return id;
}

export async function saveAnalysisResult(
  client: PoolClient,
  input: {
    taskId: string;
    mediaId: string;
    providerId: string;
    modelId: string | null;
    simulated: boolean;
    attributes: StoredAttribute[];
  },
): Promise<void> {
  const id = await createAnalysisShell(client, input);
  await client.query(`UPDATE garment_analyses SET model_id = $2, simulated = $3 WHERE id = $1`, [
    id,
    input.modelId,
    input.simulated,
  ]);
  const existing = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM garment_analysis_attributes WHERE analysis_id = $1`,
    [id],
  );
  if (Number(existing.rows[0]?.total ?? 0) > 0) return;
  for (const attribute of input.attributes) {
    await client.query(
      `INSERT INTO garment_analysis_attributes (
         analysis_id, attribute_key, value_json, basis, note, confidence, confidence_source, review_status
       )
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, 'pending')`,
      [
        id,
        attribute.key,
        JSON.stringify(attribute.value),
        attribute.basis,
        attribute.note,
        attribute.confidence,
        attribute.confidenceSource,
      ],
    );
  }
}

export async function requireAnalysis(client: PoolClient, actorUserId: string, analysisId: string): Promise<AnalysisView> {
  const found = await client.query<{ task_id: string }>(`SELECT task_id FROM garment_analyses WHERE id = $1`, [analysisId]);
  const taskId = found.rows[0]?.task_id;
  if (!taskId) throw notFound("Analysis was not found.");
  await requireTask(client, actorUserId, taskId);
  const view = await loadAnalysis(client, analysisId);
  if (!view) throw notFound("Analysis was not found.");
  return view;
}

export async function listAnalyses(
  client: PoolClient,
  actorUserId: string,
  query: { limit: number; offset: number },
): Promise<{ analyses: AnalysisView[]; total: number }> {
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM garment_analyses AS analysis
     JOIN ai_tasks AS task ON task.id = analysis.task_id
     WHERE ${visibleTask("task", "$1")}`,
    [actorUserId],
  );
  const page = await client.query<{ id: string }>(
    `SELECT analysis.id
     FROM garment_analyses AS analysis
     JOIN ai_tasks AS task ON task.id = analysis.task_id
     WHERE ${visibleTask("task", "$1")}
     ORDER BY analysis.created_at DESC, analysis.id DESC
     LIMIT $2 OFFSET $3`,
    [actorUserId, query.limit, query.offset],
  );
  const analyses: AnalysisView[] = [];
  for (const row of page.rows) {
    const view = await loadAnalysis(client, row.id);
    if (view) analyses.push(view);
  }
  return { analyses, total: Number(total.rows[0]?.total ?? 0) };
}

export async function reviewAttribute(
  client: PoolClient,
  actorUserId: string,
  analysisId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<AnalysisView> {
  const analysis = await lockAnalysis(client, actorUserId, analysisId);
  if (analysis.status !== "succeeded") throw invalid("invalid_status", "The analysis is not ready for review.");
  if (!attributeKeys.includes(key as (typeof attributeKeys)[number])) {
    throw invalid("invalid_attribute", "Attribute is not recognized.");
  }
  const decision = body.decision;
  if (decision === "accept" || decision === "reject") {
    const current = analysis.attributes.find((item) => item.key === key);
    if (!current) throw invalid("invalid_attribute", "Attribute is not recognized.");
    if (decision === "accept" && current.basis === "unknown") {
      throw invalid("invalid_attribute", "An unknown attribute cannot be accepted.");
    }
    await client.query(
      `UPDATE garment_analysis_attributes
       SET review_status = $3, reviewed_by_user_id = $4, reviewed_at = now()
       WHERE analysis_id = $1 AND attribute_key = $2`,
      [analysisId, key, decision === "accept" ? "accepted" : "rejected", actorUserId],
    );
    await addAnalysisEvent(client, analysisId, key, decision === "accept" ? "accepted" : "rejected", actorUserId, "Review recorded.");
    return requireAnalysis(client, actorUserId, analysisId);
  }
  if (decision !== "correct") throw invalid("invalid_attribute", "Review decision is not recognized.");
  const corrected = parseCorrection(key, body.value, body.basis, body.note);
  await client.query(
    `UPDATE garment_analysis_attributes
     SET value_json = $3::jsonb, basis = $4, note = $5, confidence = NULL, confidence_source = NULL,
         review_status = 'corrected', reviewed_by_user_id = $6, reviewed_at = now()
     WHERE analysis_id = $1 AND attribute_key = $2`,
    [analysisId, key, JSON.stringify(corrected.value), corrected.basis, corrected.note, actorUserId],
  );
  await addAnalysisEvent(client, analysisId, key, "corrected", actorUserId, "Attribute corrected.");
  return requireAnalysis(client, actorUserId, analysisId);
}

export async function applyAnalysis(
  client: PoolClient,
  actorUserId: string,
  analysisId: string,
  garmentId: string,
  replaceKinds: string[],
): Promise<AnalysisView> {
  const analysis = await lockAnalysis(client, actorUserId, analysisId);
  if (analysis.status !== "succeeded") throw invalid("invalid_status", "The analysis is not ready to apply.");
  const garment = await client.query<{ owner_user_id: string | null; owner_organization_id: string | null; garment_type_id: string | null }>(
    `SELECT owner_user_id, owner_organization_id, garment_type_id FROM garments WHERE id = $1 FOR UPDATE`,
    [garmentId],
  );
  const row = garment.rows[0];
  if (!row) throw notFound("Garment was not found.");
  const allowed = await actorMayAccessOwner(client, actorUserId, ownerFromIds(row.owner_user_id, row.owner_organization_id));
  if (!allowed) throw notFound("Garment was not found.");
  const approved = analysis.attributes.filter((item) => item.reviewStatus === "accepted" || item.reviewStatus === "corrected");
  if (approved.length === 0) throw invalid("invalid_attribute", "Accept an attribute before applying it.");
  const existing = await client.query<{ kind: string; slug: string }>(
    `SELECT fashion_terms.kind, fashion_terms.slug
     FROM garment_terms
     JOIN fashion_terms ON fashion_terms.id = garment_terms.term_id
     WHERE garment_terms.garment_id = $1`,
    [garmentId],
  );
  const present = new Set(existing.rows.map((item) => item.kind));
  if (row.garment_type_id) present.add("garment_type");
  const applied: { key: string; kind: string; slug: string }[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const replace = new Set(replaceKinds);
  const grouped = new Map<string, { key: string; slug: string }[]>();
  for (const attribute of approved) {
    if (attribute.key === "apparent_material") {
      skipped.push({ key: attribute.key, reason: "Material appearance is not written onto the catalog." });
      continue;
    }
    const kind = catalogKind[attribute.key];
    if (!kind || attribute.value === null) {
      skipped.push({ key: attribute.key, reason: "This attribute is kept on the analysis draft." });
      continue;
    }
    if (present.has(kind) && !replace.has(kind)) {
      skipped.push({ key: attribute.key, reason: "Existing catalog values were kept." });
      continue;
    }
    const slugs = Array.isArray(attribute.value) ? attribute.value : [String(attribute.value)];
    for (const slug of slugs) {
      const bucket = grouped.get(kind) ?? [];
      bucket.push({ key: attribute.key, slug });
      grouped.set(kind, bucket);
    }
  }
  for (const [kind, entries] of grouped) {
    const writable = [];
    for (const entry of entries) {
      const term = await client.query<{ id: string }>(
        `SELECT id FROM fashion_terms WHERE kind = $1 AND slug = $2`,
        [kind, entry.slug],
      );
      if (!term.rows[0]) {
        skipped.push({ key: entry.key, reason: "The value is not a catalog term." });
        continue;
      }
      writable.push(entry);
    }
    if (writable.length === 0) continue;
    if (replace.has(kind)) {
      await client.query(
        `DELETE FROM garment_terms
         WHERE garment_id = $1 AND term_id IN (SELECT id FROM fashion_terms WHERE kind = $2)`,
        [garmentId, kind],
      );
    }
    for (const entry of writable) {
      await client.query(
        `INSERT INTO garment_terms (garment_id, term_id)
         SELECT $1, id FROM fashion_terms WHERE kind = $2 AND slug = $3
         ON CONFLICT DO NOTHING`,
        [garmentId, kind, entry.slug],
      );
      applied.push({ key: entry.key, kind, slug: entry.slug });
    }
    if (kind === "garment_type") {
      await client.query(
        `UPDATE garments SET garment_type_id = (
           SELECT id FROM fashion_terms WHERE kind = 'garment_type' AND slug = $2
         ) WHERE id = $1`,
        [garmentId, writable[0]?.slug],
      );
    }
  }
  await client.query(
    `INSERT INTO garment_analysis_applications (analysis_id, garment_id, actor_user_id, applied, skipped)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [analysisId, garmentId, actorUserId, JSON.stringify(applied), JSON.stringify(skipped)],
  );
  await addAnalysisEvent(client, analysisId, null, "applied", actorUserId, "Reviewed attributes were applied.");
  for (const item of skipped) {
    await addAnalysisEvent(client, analysisId, item.key, "apply_skipped", actorUserId, item.reason);
  }
  return requireAnalysis(client, actorUserId, analysisId);
}

async function lockAnalysis(client: PoolClient, actorUserId: string, analysisId: string): Promise<AnalysisView> {
  const locked = await client.query(`SELECT id FROM garment_analyses WHERE id = $1 FOR UPDATE`, [analysisId]);
  if (!locked.rowCount) throw notFound("Analysis was not found.");
  return requireAnalysis(client, actorUserId, analysisId);
}

async function loadAnalysis(client: PoolClient, analysisId: string): Promise<AnalysisView | null> {
  const found = await client.query<{
    id: string;
    task_id: string;
    media_id: string;
    schema_version: string;
    simulated: boolean;
    provider_id: string;
    model_id: string | null;
    created_at: Date;
    status: string;
    error_category: string | null;
    error_message: string | null;
    summary: string | null;
  }>(
    `SELECT analysis.id, analysis.task_id, analysis.media_id, analysis.schema_version, analysis.simulated,
            analysis.provider_id, analysis.model_id, analysis.created_at, task.status,
            task.error_category, task.error_message, output.summary
     FROM garment_analyses AS analysis
     JOIN ai_tasks AS task ON task.id = analysis.task_id
     LEFT JOIN ai_task_outputs AS output ON output.task_id = task.id
     WHERE analysis.id = $1`,
    [analysisId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const attributes = await client.query<{
    attribute_key: string;
    value_json: unknown;
    basis: AnalysisAttribute["basis"];
    note: string;
    confidence: string | null;
    confidence_source: "provider" | null;
    review_status: AnalysisAttribute["reviewStatus"];
  }>(
    `SELECT attribute_key, value_json, basis, note, confidence, confidence_source, review_status
     FROM garment_analysis_attributes WHERE analysis_id = $1 ORDER BY attribute_key`,
    [analysisId],
  );
  const applications = await client.query<{ garment_id: string; applied: unknown; skipped: unknown; created_at: Date }>(
    `SELECT garment_id, applied, skipped, created_at
     FROM garment_analysis_applications WHERE analysis_id = $1 ORDER BY created_at`,
    [analysisId],
  );
  return {
    id: row.id,
    taskId: row.task_id,
    mediaId: row.media_id,
    schemaVersion: row.schema_version,
    simulated: row.simulated,
    operational: false,
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status,
    error: row.error_category && row.error_message ? { category: row.error_category, message: row.error_message } : null,
    summary: row.summary,
    attributes: attributes.rows.map((item) => ({
      key: item.attribute_key,
      value: item.value_json as AnalysisAttribute["value"],
      basis: item.basis,
      note: item.note,
      confidence: item.confidence == null ? null : Number(item.confidence),
      confidenceSource: item.confidence_source,
      reviewStatus: item.review_status,
      fiberEstablished: false,
    })),
    applications: applications.rows.map((item) => ({
      garmentId: item.garment_id,
      applied: item.applied,
      skipped: item.skipped,
      createdAt: new Date(item.created_at).toISOString(),
    })),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function parseAttribute(
  key: string,
  raw: unknown,
  mode: "provider" | "review",
): { ok: true; attribute: StoredAttribute } | { ok: false; message: string } {
  if (!attributeKeys.includes(key as (typeof attributeKeys)[number])) {
    return { ok: false, message: "Attribute is not recognized." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "The analysis result did not match the schema." };
  }
  const record = raw as Record<string, unknown>;
  const allowed = new Set(["value", "basis", "note", "confidence", "confidenceSource"]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) return { ok: false, message: "The analysis result did not match the schema." };
  }
  const basis = record.basis;
  if (basis !== "observed" && basis !== "inferred" && basis !== "unknown") {
    return { ok: false, message: "The analysis result did not match the schema." };
  }
  if (key === "apparent_material" && basis === "observed") {
    return { ok: false, message: "An image cannot establish a fiber." };
  }
  if (mode === "provider" && basis === "observed") {
    return { ok: false, message: "A simulated analysis cannot claim a visual observation." };
  }
  const note = typeof record.note === "string" ? record.note.trim() : "";
  if (note.length > 240) return { ok: false, message: "The analysis result did not match the schema." };
  if (mode === "provider" && basis === "inferred" && !note.includes("Simulated fixture")) {
    return { ok: false, message: "The analysis result did not match the schema." };
  }
  if (basis === "inferred" && key === "apparent_material" && note.length === 0) {
    return { ok: false, message: "An image cannot establish a fiber." };
  }
  let confidence: number | null = null;
  let confidenceSource: "provider" | null = null;
  if (record.confidence !== undefined && record.confidence !== null) {
    if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
      return { ok: false, message: "The analysis result did not match the schema." };
    }
    if (record.confidenceSource !== "provider") {
      return { ok: false, message: "The analysis result did not match the schema." };
    }
    confidence = record.confidence;
    confidenceSource = "provider";
  }
  if (basis === "unknown") {
    if (record.value !== null && record.value !== undefined) {
      return { ok: false, message: "The analysis result did not match the schema." };
    }
    return { ok: true, attribute: unknownAttribute(key) };
  }
  const value = readValue(key, record.value);
  if (!value.ok) return value;
  return {
    ok: true,
    attribute: {
      key,
      value: value.value,
      basis,
      note,
      confidence,
      confidenceSource,
      reviewStatus: "pending",
      fiberEstablished: false,
    },
  };
}

function readValue(
  key: string,
  value: unknown,
): { ok: true; value: string | number | string[] } | { ok: false; message: string } {
  if (countKeys.has(key)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12) {
      return { ok: false, message: "The analysis result did not match the schema." };
    }
    return { ok: true, value };
  }
  if (listKeys.has(key)) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
      return { ok: false, message: "The analysis result did not match the schema." };
    }
    const slugs: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item)) {
        return { ok: false, message: "The analysis result did not match the schema." };
      }
      slugs.push(item);
    }
    return { ok: true, value: slugs };
  }
  if (typeof value !== "string") return { ok: false, message: "The analysis result did not match the schema." };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return { ok: false, message: "The analysis result did not match the schema." };
  if (catalogKind[key] && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    return { ok: false, message: "The analysis result did not match the schema." };
  }
  return { ok: true, value: trimmed };
}

function unknownAttribute(key: string): StoredAttribute {
  return {
    key,
    value: null,
    basis: "unknown",
    note: "",
    confidence: null,
    confidenceSource: null,
    reviewStatus: "pending",
    fiberEstablished: false,
  };
}

async function addAnalysisEvent(
  client: PoolClient,
  analysisId: string,
  key: string | null,
  action: string,
  actorUserId: string,
  detail: string,
) {
  await client.query(
    `INSERT INTO garment_analysis_events (analysis_id, attribute_key, action, actor_user_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [analysisId, key, action, actorUserId, detail],
  );
}

function visibleTask(alias: string, actor: string): string {
  return `(
    ${alias}.owner_user_id = ${actor}::uuid
    OR EXISTS (
      SELECT 1 FROM organization_memberships AS membership
      WHERE membership.organization_id = ${alias}.owner_organization_id
        AND membership.user_id = ${actor}::uuid
        AND membership.status = 'active'
    )
  )`;
}
