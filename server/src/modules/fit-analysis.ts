import type { PoolClient } from "pg";
import { invalid, notFound } from "../errors";
import { requireProfile } from "./body-measurements";
import { getCatalogGarment } from "./fashion";
import {
  analyzeDimensions,
  describeFitRules,
  fitMappings,
  fitRuleSetId,
  type FitComparison,
  type FitNote,
  type FitRuleResult,
  type FitSize,
} from "./fit-rules";

type BodyRow = {
  id: string;
  slug: string;
  canonical_cm: string;
  source: string;
  verification_status: "unverified" | "verified";
  recorded_at: Date;
};

type GarmentRow = {
  id: string;
  slug: string;
  canonical_cm: string;
  provenance: string;
  size_system: string | null;
  size_label: string | null;
};

export type FitAnalysisView = {
  id: string;
  classification: FitRuleResult["classification"];
  summary: string;
  ruleSet: typeof fitRuleSetId;
  easeApplied: false;
  fitGuarantee: false;
  fitPreference: null;
  profileId: string;
  garmentId: string;
  garmentCategory: string | null;
  comparisons: FitComparison[];
  notes: FitNote[];
  dimensionalProximity: FitRuleResult["dimensionalProximity"];
  createdAt: string;
};

export function fitRuleDescription() {
  return describeFitRules();
}

export async function createFitAnalysis(
  client: PoolClient,
  actorUserId: string,
  input: { profileId: string; garmentId: string; size?: FitSize | null },
): Promise<FitAnalysisView> {
  await requireProfile(client, actorUserId, input.profileId);
  const garment = await getCatalogGarment(client, actorUserId, input.garmentId);
  const category = garment.garmentType?.slug ?? null;
  const selected = input.size ? await requireGarmentSize(client, input.garmentId, input.size) : null;
  const bodies = await currentBodyRows(client, input.profileId);
  const garmentRows = await garmentRowsFor(client, input.garmentId, selected);
  const skippedAi = bodies.filter((row) => row.source === "ai_estimated").map((row) => row.slug);
  const usable = bodies.filter((row) => row.source !== "ai_estimated");
  const result = analyzeDimensions({
    garmentCategory: category,
    comparisons: buildComparisons(usable, garmentRows),
    missing: missingPairs(usable, garmentRows),
    unmappedGarmentDefinitions: garmentRows
      .filter((row) => !fitMappings.some((mapping) => mapping.garmentDefinition === row.slug))
      .map((row) => row.slug),
    skippedAiDefinitions: skippedAi,
  });

  const inserted = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO fit_analyses (profile_id, garment_id, garment_category, rule_set, classification, summary, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [input.profileId, input.garmentId, category, fitRuleSetId, result.classification, result.summary, actorUserId],
  );
  const row = inserted.rows[0];
  if (!row) throw invalid("invalid_body", "Fit analysis could not be saved.");
  for (const comparison of result.comparisons) {
    const body = usable.find((item) => item.slug === comparison.bodyDefinition);
    const garmentMeasurement = garmentRows.find(
      (item) =>
        item.slug === comparison.garmentDefinition &&
        item.size_system === (comparison.size?.system ?? null) &&
        item.size_label === (comparison.size?.label ?? null),
    );
    if (!body || !garmentMeasurement) throw invalid("invalid_body", "Fit analysis could not be saved.");
    await client.query(
      `INSERT INTO fit_analysis_comparisons (
         analysis_id, size_system, size_label, body_definition, garment_definition,
         body_measurement_id, garment_measurement_id, body_canonical_cm, garment_canonical_cm, difference_cm,
         body_source, body_verification, body_recorded_at, garment_provenance
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        row.id,
        comparison.size?.system ?? null,
        comparison.size?.label ?? null,
        comparison.bodyDefinition,
        comparison.garmentDefinition,
        body.id,
        garmentMeasurement.id,
        comparison.bodyCm,
        comparison.garmentCm,
        comparison.differenceCm,
        comparison.bodySource,
        comparison.bodyVerification,
        comparison.bodyRecordedAt,
        comparison.garmentProvenance,
      ],
    );
  }
  for (let index = 0; index < result.notes.length; index += 1) {
    const note = result.notes[index];
    if (!note) continue;
    await client.query(
      `INSERT INTO fit_analysis_notes (analysis_id, position, kind, message) VALUES ($1, $2, $3, $4)`,
      [row.id, index + 1, note.kind, note.message],
    );
  }
  return loadAnalysis(client, actorUserId, row.id);
}

export async function listFitAnalyses(
  client: PoolClient,
  actorUserId: string,
  query: { limit: number; offset: number; profileId?: string },
): Promise<{ analyses: FitAnalysisView[]; total: number }> {
  const params: unknown[] = [actorUserId];
  const filters = [profileVisible("$1")];
  if (query.profileId) {
    params.push(query.profileId);
    filters.push(`analysis.profile_id = $${params.length}`);
  }
  const where = `${filters.join(" AND ")} AND ${garmentVisible("$1")}`;
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM fit_analyses AS analysis
     JOIN measurement_profiles AS profile ON profile.id = analysis.profile_id
     WHERE ${where}`,
    params,
  );
  const pageParams = [...params, query.limit, query.offset];
  const page = await client.query<{ id: string }>(
    `SELECT analysis.id
     FROM fit_analyses AS analysis
     JOIN measurement_profiles AS profile ON profile.id = analysis.profile_id
     WHERE ${where}
     ORDER BY analysis.created_at DESC, analysis.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    pageParams,
  );
  const analyses: FitAnalysisView[] = [];
  for (const row of page.rows) {
    try {
      analyses.push(await loadAnalysis(client, actorUserId, row.id));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { analyses, total: analyses.length === page.rows.length ? Number(total.rows[0]?.total ?? 0) : analyses.length };
}

export async function requireFitAnalysis(client: PoolClient, actorUserId: string, analysisId: string): Promise<FitAnalysisView> {
  return loadAnalysis(client, actorUserId, analysisId);
}

async function loadAnalysis(client: PoolClient, actorUserId: string, analysisId: string): Promise<FitAnalysisView> {
  const found = await client.query<{
    id: string;
    profile_id: string;
    garment_id: string;
    garment_category: string | null;
    classification: FitRuleResult["classification"];
    summary: string;
    created_at: Date;
  }>(
    `SELECT analysis.id, analysis.profile_id, analysis.garment_id, analysis.garment_category,
            analysis.classification, analysis.summary, analysis.created_at
     FROM fit_analyses AS analysis
     JOIN measurement_profiles AS profile ON profile.id = analysis.profile_id
     WHERE analysis.id = $2 AND ${profileVisible("$1")}`,
    [actorUserId, analysisId],
  );
  const analysis = found.rows[0];
  if (!analysis) throw notFound("Fit analysis was not found.");
  await getCatalogGarment(client, actorUserId, analysis.garment_id);
  const comparisons = await client.query<{
    size_system: string | null;
    size_label: string | null;
    body_definition: string;
    garment_definition: string;
    body_canonical_cm: string;
    garment_canonical_cm: string;
    difference_cm: string;
    body_source: string;
    body_verification: "unverified" | "verified";
    body_recorded_at: Date;
    garment_provenance: string;
  }>(
    `SELECT size_system, size_label, body_definition, garment_definition,
            body_canonical_cm::text, garment_canonical_cm::text, difference_cm::text,
            body_source, body_verification, body_recorded_at, garment_provenance
     FROM fit_analysis_comparisons
     WHERE analysis_id = $1
     ORDER BY size_label NULLS FIRST, body_definition`,
    [analysisId],
  );
  const notes = await client.query<FitNote>(
    `SELECT kind, message FROM fit_analysis_notes WHERE analysis_id = $1 ORDER BY position`,
    [analysisId],
  );
  const viewComparisons: FitComparison[] = comparisons.rows.map((row) => ({
    size: row.size_system && row.size_label ? { system: row.size_system, label: row.size_label } : null,
    bodyDefinition: row.body_definition,
    garmentDefinition: row.garment_definition,
    label: fitMappings.find((mapping) => mapping.bodyDefinition === row.body_definition)?.label ?? row.body_definition,
    bodyCm: row.body_canonical_cm,
    garmentCm: row.garment_canonical_cm,
    differenceCm: row.difference_cm,
    bodySource: row.body_source,
    bodyVerification: row.body_verification,
    bodyRecordedAt: new Date(row.body_recorded_at).toISOString(),
    garmentProvenance: row.garment_provenance,
  }));
  return {
    id: analysis.id,
    classification: analysis.classification,
    summary: analysis.summary,
    ruleSet: fitRuleSetId,
    easeApplied: false,
    fitGuarantee: false,
    fitPreference: null,
    profileId: analysis.profile_id,
    garmentId: analysis.garment_id,
    garmentCategory: analysis.garment_category,
    comparisons: viewComparisons,
    notes: notes.rows,
    dimensionalProximity: analyzeDimensions({
      garmentCategory: analysis.garment_category,
      comparisons: viewComparisons,
      missing: [],
      unmappedGarmentDefinitions: [],
      skippedAiDefinitions: [],
    }).dimensionalProximity,
    createdAt: new Date(analysis.created_at).toISOString(),
  };
}

async function currentBodyRows(client: PoolClient, profileId: string): Promise<BodyRow[]> {
  const found = await client.query<BodyRow>(
    `SELECT measurement.id, definition.slug, measurement.canonical_cm::text AS canonical_cm,
            measurement.source, measurement.verification_status, measurement.recorded_at
     FROM body_measurements AS measurement
     JOIN measurement_definitions AS definition ON definition.id = measurement.definition_id
     WHERE measurement.profile_id = $1 AND measurement.record_status = 'current' AND definition.subject = 'body'`,
    [profileId],
  );
  return found.rows;
}

async function garmentRowsFor(client: PoolClient, garmentId: string, size: { id: string; size: FitSize } | null): Promise<GarmentRow[]> {
  const params: unknown[] = [garmentId];
  let sizeSql = "";
  if (size) {
    params.push(size.id);
    sizeSql = ` AND garment_measurements.size_label_id = $2`;
  }
  const found = await client.query<GarmentRow>(
    `SELECT garment_measurements.id, measurement_definitions.slug,
            garment_measurements.value::text AS canonical_cm, garment_measurements.provenance,
            size_systems.slug AS size_system, size_labels.label AS size_label
     FROM garment_measurements
     JOIN measurement_definitions ON measurement_definitions.id = garment_measurements.definition_id
     LEFT JOIN size_labels ON size_labels.id = garment_measurements.size_label_id
     LEFT JOIN size_systems ON size_systems.id = size_labels.size_system_id
     WHERE garment_measurements.garment_id = $1 AND measurement_definitions.subject = 'garment'${sizeSql}`,
    params,
  );
  return found.rows;
}

async function requireGarmentSize(client: PoolClient, garmentId: string, size: FitSize): Promise<{ id: string; size: FitSize }> {
  const found = await client.query<{ id: string }>(
    `SELECT size_labels.id
     FROM garment_size_labels
     JOIN size_labels ON size_labels.id = garment_size_labels.size_label_id
     JOIN size_systems ON size_systems.id = size_labels.size_system_id
     WHERE garment_size_labels.garment_id = $1 AND size_systems.slug = $2 AND size_labels.label = $3`,
    [garmentId, size.system, size.label],
  );
  const id = found.rows[0]?.id;
  if (!id) throw invalid("unknown_size", "Assign that size label to the garment first.");
  return { id, size };
}

function buildComparisons(bodies: BodyRow[], garments: GarmentRow[]): FitRuleResult["comparisons"] {
  const comparisons: FitRuleResult["comparisons"] = [];
  for (const garment of garments) {
    const mapping = fitMappings.find((item) => item.garmentDefinition === garment.slug);
    if (!mapping) continue;
    const body = bodies.find((item) => item.slug === mapping.bodyDefinition);
    if (!body) continue;
    comparisons.push({
      size: garment.size_system && garment.size_label ? { system: garment.size_system, label: garment.size_label } : null,
      bodyDefinition: mapping.bodyDefinition,
      garmentDefinition: mapping.garmentDefinition,
      label: mapping.label,
      bodyCm: body.canonical_cm,
      garmentCm: garment.canonical_cm,
      differenceCm: "0.00",
      bodySource: body.source,
      bodyVerification: body.verification_status,
      bodyRecordedAt: new Date(body.recorded_at).toISOString(),
      garmentProvenance: garment.provenance,
    });
  }
  return comparisons;
}

function missingPairs(bodies: BodyRow[], garments: GarmentRow[]) {
  const sizes = new Map<string, FitSize | null>();
  if (garments.length === 0) sizes.set("none", null);
  for (const garment of garments) {
    const key = garment.size_label ? `${garment.size_system}:${garment.size_label}` : "unspecified";
    sizes.set(key, garment.size_system && garment.size_label ? { system: garment.size_system, label: garment.size_label } : null);
  }
  const missing: { size: FitSize | null; mapping: (typeof fitMappings)[number]; absent: "body" | "garment" }[] = [];
  for (const size of sizes.values()) {
    for (const mapping of fitMappings) {
      const body = bodies.some((item) => item.slug === mapping.bodyDefinition);
      const garment = garments.some(
        (item) =>
          item.slug === mapping.garmentDefinition &&
          (size ? item.size_system === size.system && item.size_label === size.label : item.size_label === null),
      );
      if (body === garment) continue;
      missing.push({ size, mapping, absent: body ? "garment" : "body" });
    }
  }
  return missing;
}

function garmentVisible(actor: string): string {
  return `EXISTS (
    SELECT 1 FROM garments AS garment
    WHERE garment.id = analysis.garment_id
      AND (
        garment.visibility = 'public'
        OR garment.owner_user_id = ${actor}::uuid
        OR EXISTS (
          SELECT 1 FROM organization_memberships AS membership
          WHERE membership.organization_id = garment.owner_organization_id
            AND membership.user_id = ${actor}::uuid
            AND membership.status = 'active'
        )
      )
  )`;
}

function profileVisible(actor: string): string {
  return `(
    profile.subject_user_id = ${actor}::uuid
    OR EXISTS (
      SELECT 1 FROM measurement_profile_grants AS grant_row
      WHERE grant_row.profile_id = profile.id
        AND grant_row.grantee_user_id = ${actor}::uuid
        AND grant_row.revoked_at IS NULL
    )
  )`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code: string }).code === "not_found";
}
