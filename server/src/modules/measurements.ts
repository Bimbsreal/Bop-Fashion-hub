import type { PoolClient } from "pg";
import { actorMayAccessOwner, ownerFromIds } from "./access";
import { invalid, notFound } from "../errors";
import { acceptedEntry, centimetresToHundredths, convertMeasurement, isMeasureUnit, type MeasureUnit } from "./measure-units";

export type SizeLabelRef = { system: string; label: string };

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function replaceSizeLabels(
  client: PoolClient,
  actorUserId: string,
  garmentId: string,
  labels: SizeLabelRef[],
): Promise<void> {
  await requireGarmentEditor(client, actorUserId, garmentId);
  const requested = normalizeLabels(labels);
  await client.query(`DELETE FROM garment_size_labels WHERE garment_id = $1`, [garmentId]);
  if (requested.length > 0) {
    await client.query(
      `INSERT INTO garment_size_labels (garment_id, size_label_id)
       SELECT $1, size_labels.id
       FROM unnest($2::text[], $3::text[]) AS requested(system_slug, label)
       JOIN size_systems ON size_systems.slug = requested.system_slug
       JOIN size_labels
         ON size_labels.size_system_id = size_systems.id
        AND size_labels.label = requested.label`,
      [garmentId, requested.map((label) => label.system), requested.map((label) => label.label)],
    );
    const linked = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM garment_size_labels WHERE garment_id = $1`,
      [garmentId],
    );
    if (Number(linked.rows[0]?.count) !== requested.length) {
      throw invalid("unknown_size", "One or more size labels were not found.");
    }
  }
  await client.query(
    `DELETE FROM garment_measurements AS measurement
     WHERE measurement.garment_id = $1
       AND measurement.size_label_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM garment_size_labels AS assigned
         WHERE assigned.garment_id = measurement.garment_id
           AND assigned.size_label_id = measurement.size_label_id
       )`,
    [garmentId],
  );
}

export async function recordGarmentMeasurement(
  client: PoolClient,
  actorUserId: string,
  garmentId: string,
  input: { definition: string; value: number; size?: SizeLabelRef | null; unit?: string },
): Promise<void> {
  await requireGarmentEditor(client, actorUserId, garmentId);
  const definition = input.definition.trim().toLowerCase();
  if (!slugPattern.test(definition)) throw invalid("unknown_measurement", "Measurement was not found.");
  if (!Number.isFinite(input.value) || input.value <= 0 || input.value >= 10000) {
    throw invalid("invalid_measurement", "Measurement value must be greater than 0.");
  }

  const found = await client.query<{ id: string; subject: string; unit: string }>(
    `SELECT id, subject, unit FROM measurement_definitions WHERE slug = $1`,
    [definition],
  );
  const definitionRow = found.rows[0];
  if (!definitionRow) throw invalid("unknown_measurement", "Measurement was not found.");
  if (definitionRow.subject !== "garment") {
    throw invalid("wrong_subject", "That measurement describes a body, not a garment.");
  }
  if (definitionRow.unit !== "cm") throw invalid("invalid_unit", "This garment definition is not stored in centimetres.");
  const entered = garmentEntry(input.value, input.unit);
  const hundredths = centimetresToHundredths(entered.canonicalCm);
  if (hundredths <= BigInt(0) || hundredths >= BigInt(1000000)) {
    throw invalid("invalid_measurement", "Garment dimension must be greater than 0 and below 10000 cm.");
  }

  let sizeLabelId: string | null = null;
  if (input.size) {
    const labels = normalizeLabels([input.size]);
    const size = labels[0];
    if (!size) throw invalid("unknown_size", "Size label was not found.");
    const match = await client.query<{ id: string }>(
      `SELECT size_labels.id
       FROM garment_size_labels
       JOIN size_labels ON size_labels.id = garment_size_labels.size_label_id
       JOIN size_systems ON size_systems.id = size_labels.size_system_id
       WHERE garment_size_labels.garment_id = $1
         AND size_systems.slug = $2
         AND size_labels.label = $3`,
      [garmentId, size.system, size.label],
    );
    sizeLabelId = match.rows[0]?.id ?? null;
    if (!sizeLabelId) throw invalid("unknown_size", "Assign that size label to the garment first.");
  }

  try {
    await client.query(
      `INSERT INTO garment_measurements (
         garment_id, definition_id, size_label_id, value, entered_value, entered_unit, provenance
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'stated')`,
      [garmentId, definitionRow.id, sizeLabelId, entered.canonicalCm, entered.enteredText, entered.unit],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw invalid("duplicate_measurement", "That measurement is already recorded.");
    }
    throw error;
  }
}

async function requireGarmentEditor(client: PoolClient, actorUserId: string, garmentId: string): Promise<void> {
  const garment = await client.query<{ owner_user_id: string | null; owner_organization_id: string | null }>(
    `SELECT owner_user_id, owner_organization_id FROM garments WHERE id = $1 FOR UPDATE`,
    [garmentId],
  );
  const row = garment.rows[0];
  if (!row) throw notFound("Garment was not found.");
  const allowed = await actorMayAccessOwner(
    client,
    actorUserId,
    ownerFromIds(row.owner_user_id, row.owner_organization_id),
  );
  if (!allowed) throw notFound("Garment was not found.");
}

function normalizeLabels(labels: SizeLabelRef[]): SizeLabelRef[] {
  const seen = new Set<string>();
  const normalized: SizeLabelRef[] = [];
  for (const label of labels) {
    const system = label.system.trim().toLowerCase();
    const name = label.label.trim();
    if (!slugPattern.test(system) || !name || name.length > 32) {
      throw invalid("unknown_size", "Size label was not found.");
    }
    const key = `${system}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ system, label: name });
  }
  return normalized;
}

function garmentEntry(value: number, unit: string | undefined): { enteredText: string; canonicalCm: string; unit: MeasureUnit } {
  if (unit === undefined || unit === "cm") {
    const enteredText = String(value);
    if (!acceptedEntry(enteredText, "cm")) {
      throw invalid("invalid_measurement", "Enter a positive garment dimension in centimetres, metres, or inches.");
    }
    return { enteredText, canonicalCm: convertMeasurement(enteredText, "cm").canonicalCm, unit: "cm" };
  }
  if (!isMeasureUnit(unit)) throw invalid("invalid_unit", "Use centimetres, metres, or inches.");
  const enteredText = String(value);
  if (!acceptedEntry(enteredText, unit)) {
    throw invalid("invalid_measurement", "Enter a positive garment dimension in centimetres, metres, or inches.");
  }
  return { enteredText, canonicalCm: convertMeasurement(enteredText, unit).canonicalCm, unit };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
