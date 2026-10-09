import type { PoolClient } from "pg";
import { invalid, notFound } from "../errors";
import {
  acceptedEntry,
  centimetresToHundredths,
  convertMeasurement,
  displayCanonical,
  isMeasureUnit,
  type MeasureUnit,
} from "./measure-units";

const sources = new Set(["user_entered", "tailor_recorded", "professionally_verified", "imported", "ai_estimated"]);
const permissions = new Set(["read", "record", "verify"]);
const profileLimit = 12;

type Access = "subject" | "read" | "record" | "verify";

type ProfileRow = {
  id: string;
  subject_user_id: string;
  name: string;
  notes: string;
  preferred_unit: MeasureUnit;
  status: "active" | "archived";
  created_at: Date;
  updated_at: Date;
};

type MeasurementRow = {
  id: string;
  definition: string;
  name: string;
  entered_text: string;
  entered_unit: MeasureUnit;
  canonical_cm: string;
  source: string;
  verification_status: "unverified" | "verified";
  record_status: "current" | "superseded" | "archived";
  note: string;
  recorded_at: Date;
  verified_at: Date | null;
  recorded_by: string;
  verified_by: string | null;
};

export type BodyMeasurementView = {
  id: string;
  definition: string;
  name: string;
  enteredValue: string;
  enteredUnit: MeasureUnit;
  canonicalCm: string;
  displayValue: string;
  displayUnit: MeasureUnit;
  source: string;
  verificationStatus: "unverified" | "verified";
  recordStatus: "current" | "superseded" | "archived";
  note: string;
  recordedAt: string;
  verifiedAt: string | null;
  recordedBy: { displayName: string };
  verifiedBy: { displayName: string } | null;
};

export type MeasurementProfileView = {
  id: string;
  name: string;
  notes: string;
  preferredUnit: MeasureUnit;
  status: "active" | "archived";
  access: Access;
  fitAnalysis: false;
  imageExtraction: false;
  measurements: BodyMeasurementView[];
  grants: { userId: string; displayName: string; email: string; permission: string }[];
  createdAt: string;
  updatedAt: string;
};

export async function listBodyDefinitions(client: PoolClient) {
  const found = await client.query<{ slug: string; name: string; min_cm: string; max_cm: string }>(
    `SELECT slug, name, min_cm::text AS min_cm, max_cm::text AS max_cm
     FROM measurement_definitions
     WHERE subject = 'body'
     ORDER BY name, slug`,
  );
  return {
    canonicalUnit: "cm" as const,
    fitAnalysis: false as const,
    imageExtraction: false as const,
    definitions: found.rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      minCm: row.min_cm,
      maxCm: row.max_cm,
    })),
  };
}

export async function createMeasurementProfile(
  client: PoolClient,
  actorUserId: string,
  input: { name: string; notes: string; preferredUnit: MeasureUnit },
): Promise<MeasurementProfileView> {
  const name = cleanName(input.name);
  const notes = cleanNotes(input.notes);
  const count = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM measurement_profiles WHERE subject_user_id = $1`,
    [actorUserId],
  );
  if (Number(count.rows[0]?.total ?? 0) >= profileLimit) {
    throw invalid("profile_limit", "This account already has the maximum number of measurement profiles.");
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO measurement_profiles (subject_user_id, created_by_user_id, name, notes, preferred_unit)
     VALUES ($1, $1, $2, $3, $4)
     RETURNING id`,
    [actorUserId, name, notes, input.preferredUnit],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_body", "Measurement profile could not be saved.");
  return requireProfile(client, actorUserId, id);
}

export async function listMeasurementProfiles(
  client: PoolClient,
  actorUserId: string,
  query: { limit: number; offset: number; status: "active" | "archived" },
): Promise<{ profiles: MeasurementProfileView[]; total: number }> {
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM measurement_profiles AS profile
     WHERE profile.status = $2 AND ${visibleSql("$1")}`,
    [actorUserId, query.status],
  );
  const page = await client.query<{ id: string }>(
    `SELECT profile.id
     FROM measurement_profiles AS profile
     WHERE profile.status = $2 AND ${visibleSql("$1")}
     ORDER BY profile.updated_at DESC, profile.id DESC
     LIMIT $3 OFFSET $4`,
    [actorUserId, query.status, query.limit, query.offset],
  );
  const profiles: MeasurementProfileView[] = [];
  for (const row of page.rows) {
    profiles.push(await requireProfile(client, actorUserId, row.id));
  }
  return { profiles, total: Number(total.rows[0]?.total ?? 0) };
}

export async function requireProfile(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
): Promise<MeasurementProfileView> {
  const loaded = await loadAccess(client, actorUserId, profileId);
  if (!loaded) throw notFound("Measurement profile was not found.");
  const measurements = await listRows(client, profileId, loaded.profile.preferred_unit, null, "current");
  const grants = loaded.access === "subject" ? await listGrants(client, profileId) : [];
  return viewProfile(loaded.profile, loaded.access, measurements, grants);
}

export async function updateMeasurementProfile(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
  input: { name?: string; notes?: string; preferredUnit?: MeasureUnit; status?: "active" | "archived" },
): Promise<MeasurementProfileView> {
  const loaded = await lockProfile(client, actorUserId, profileId);
  if (loaded.access !== "subject") throw invalid("forbidden", "You cannot change this measurement profile.");
  await client.query(
    `UPDATE measurement_profiles
     SET name = $2, notes = $3, preferred_unit = $4, status = $5
     WHERE id = $1`,
    [
      profileId,
      input.name === undefined ? loaded.profile.name : cleanName(input.name),
      input.notes === undefined ? loaded.profile.notes : cleanNotes(input.notes),
      input.preferredUnit ?? loaded.profile.preferred_unit,
      input.status ?? loaded.profile.status,
    ],
  );
  return requireProfile(client, actorUserId, profileId);
}

export async function deleteMeasurementProfile(client: PoolClient, actorUserId: string, profileId: string): Promise<void> {
  const loaded = await lockProfile(client, actorUserId, profileId);
  if (loaded.access !== "subject") throw invalid("forbidden", "You cannot change this measurement profile.");
  await client.query(`DELETE FROM fit_analyses WHERE profile_id = $1`, [profileId]);
  await client.query(`DELETE FROM measurement_profiles WHERE id = $1`, [profileId]);
}

export async function recordBodyMeasurement(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
  input: { definition: string; value: string; unit: string; source: string; note: string },
): Promise<BodyMeasurementView> {
  const loaded = await lockProfile(client, actorUserId, profileId);
  if (loaded.profile.status !== "active") {
    throw invalid("archived_profile", "Reopen the profile before recording a measurement.");
  }
  if (!sources.has(input.source)) throw invalid("invalid_source", "That measurement source is not recognized.");
  if (input.source === "ai_estimated") throw invalid("unsupported_source", "AI measurement is not available.");
  assertSourceAllowed(loaded.access, input.source);
  if (!isMeasureUnit(input.unit)) throw invalid("invalid_unit", "Use centimetres, metres, or inches.");
  if (!acceptedEntry(input.value, input.unit)) {
    throw invalid("invalid_measurement", "Enter a positive measurement with the allowed decimal places.");
  }
  const converted = convertMeasurement(input.value, input.unit);
  if (centimetresToHundredths(converted.canonicalCm) <= BigInt(0)) {
    throw invalid("invalid_measurement", "Enter a measurement greater than 0.");
  }
  const definition = await bodyDefinition(client, input.definition);
  const hundredths = centimetresToHundredths(converted.canonicalCm);
  const minimum = centimetresToHundredths(definition.min_cm);
  const maximum = centimetresToHundredths(definition.max_cm);
  if (hundredths < minimum || hundredths > maximum) {
    throw invalid(
      "invalid_measurement",
      `${definition.name} must be between ${trimCm(definition.min_cm)} and ${trimCm(definition.max_cm)} cm.`,
    );
  }
  const note = cleanMeasurementNote(input.note);
  const verified = input.source === "professionally_verified";
  await client.query(
    `UPDATE body_measurements
     SET record_status = 'superseded'
     WHERE profile_id = $1 AND definition_id = $2 AND record_status = 'current'`,
    [profileId, definition.id],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO body_measurements (
       profile_id, definition_id, entered_text, entered_value, entered_unit, canonical_cm,
       source, verification_status, verified_at, verified_by_user_id, recorded_by_user_id, note
     )
     VALUES (
       $1, $2, $3, $4::numeric, $5, $6::numeric, $7,
       CASE WHEN $8 THEN 'verified' ELSE 'unverified' END,
       CASE WHEN $8 THEN now() ELSE NULL::timestamptz END,
       CASE WHEN $8 THEN $9::uuid ELSE NULL::uuid END,
       $10, $11
     )
     RETURNING id`,
    [
      profileId,
      definition.id,
      converted.enteredText,
      converted.enteredText,
      input.unit,
      converted.canonicalCm,
      input.source,
      verified,
      actorUserId,
      actorUserId,
      note,
    ],
  );
  await touchProfile(client, profileId);
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_body", "Measurement could not be saved.");
  const row = await measurementById(client, id, loaded.profile.preferred_unit);
  if (!row) throw notFound("Measurement was not found.");
  return row;
}

export async function listMeasurementHistory(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
  definition: string | null,
): Promise<BodyMeasurementView[]> {
  const loaded = await loadAccess(client, actorUserId, profileId);
  if (!loaded) throw notFound("Measurement profile was not found.");
  return listRows(client, profileId, loaded.profile.preferred_unit, definition, null);
}

export async function archiveBodyMeasurement(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
  measurementId: string,
): Promise<BodyMeasurementView> {
  const loaded = await lockProfile(client, actorUserId, profileId);
  if (loaded.access !== "subject") throw invalid("forbidden", "You cannot change this measurement profile.");
  const current = await client.query<{ id: string }>(
    `SELECT id FROM body_measurements
     WHERE id = $1 AND profile_id = $2 AND record_status = 'current'
     FOR UPDATE`,
    [measurementId, profileId],
  );
  if (!current.rows[0]) throw notFound("Measurement was not found.");
  await client.query(`UPDATE body_measurements SET record_status = 'archived' WHERE id = $1`, [measurementId]);
  await touchProfile(client, profileId);
  const row = await measurementById(client, measurementId, loaded.profile.preferred_unit);
  if (!row) throw notFound("Measurement was not found.");
  return row;
}

export async function verifyBodyMeasurement(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
  measurementId: string,
): Promise<BodyMeasurementView> {
  const loaded = await lockProfile(client, actorUserId, profileId);
  if (loaded.access !== "verify") {
    throw invalid("unsupported_verification", "Only a person with verify access can mark a measurement verified.");
  }
  const current = await client.query<{ verification_status: string }>(
    `SELECT verification_status FROM body_measurements
     WHERE id = $1 AND profile_id = $2 AND record_status = 'current'
     FOR UPDATE`,
    [measurementId, profileId],
  );
  const row = current.rows[0];
  if (!row) throw notFound("Measurement was not found.");
  if (row.verification_status !== "verified") {
    await client.query(
      `UPDATE body_measurements
       SET verification_status = 'verified', verified_at = now(), verified_by_user_id = $2
       WHERE id = $1`,
      [measurementId, actorUserId],
    );
    await touchProfile(client, profileId);
  }
  const view = await measurementById(client, measurementId, loaded.profile.preferred_unit);
  if (!view) throw notFound("Measurement was not found.");
  return view;
}

export async function grantProfileAccess(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
  input: { email: string; permission: string },
): Promise<{ userId: string; displayName: string; email: string; permission: string; created: boolean }> {
  const loaded = await lockProfile(client, actorUserId, profileId);
  if (loaded.access !== "subject") throw invalid("forbidden", "You cannot change this measurement profile.");
  if (!permissions.has(input.permission)) throw invalid("invalid_permission", "Choose read, record, or verify access.");
  const email = input.email.trim().toLowerCase();
  const person = await client.query<{ id: string; display_name: string; email: string }>(
    `SELECT id, display_name, email FROM users WHERE email = $1 AND status = 'active'`,
    [email],
  );
  const grantee = person.rows[0];
  if (!grantee) throw notFound("That person was not found.");
  if (grantee.id === loaded.profile.subject_user_id) {
    throw invalid("invalid_grant", "The profile owner already has access.");
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM measurement_profile_grants
     WHERE profile_id = $1 AND grantee_user_id = $2 AND revoked_at IS NULL`,
    [profileId, grantee.id],
  );
  if (existing.rows[0]) {
    await client.query(`UPDATE measurement_profile_grants SET permission = $2 WHERE id = $1`, [
      existing.rows[0].id,
      input.permission,
    ]);
    return { userId: grantee.id, displayName: grantee.display_name, email: grantee.email, permission: input.permission, created: false };
  }
  await client.query(
    `INSERT INTO measurement_profile_grants (profile_id, grantee_user_id, permission, granted_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [profileId, grantee.id, input.permission, actorUserId],
  );
  return { userId: grantee.id, displayName: grantee.display_name, email: grantee.email, permission: input.permission, created: true };
}

export async function revokeProfileAccess(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
  granteeUserId: string,
): Promise<void> {
  const loaded = await lockProfile(client, actorUserId, profileId);
  if (loaded.access !== "subject") throw invalid("forbidden", "You cannot change this measurement profile.");
  const revoked = await client.query(
    `UPDATE measurement_profile_grants
     SET revoked_at = now()
     WHERE profile_id = $1 AND grantee_user_id = $2 AND revoked_at IS NULL`,
    [profileId, granteeUserId],
  );
  if (!revoked.rowCount) throw notFound("That access grant was not found.");
}

function assertSourceAllowed(access: Access, source: string) {
  if ((source === "user_entered" || source === "imported") && access !== "subject") {
    throw invalid("invalid_source", "Only the profile owner can record this source.");
  }
  if (source === "tailor_recorded" && access !== "record") {
    throw invalid("invalid_source", "Tailor-recorded measurements need record access.");
  }
  if (source === "professionally_verified" && access !== "verify") {
    throw invalid("unsupported_verification", "Only a person with verify access can record a professionally verified measurement.");
  }
}

async function bodyDefinition(client: PoolClient, slug: string) {
  const definition = slug.trim().toLowerCase();
  const found = await client.query<{ id: string; name: string; min_cm: string; max_cm: string; subject: string }>(
    `SELECT id, name, min_cm::text AS min_cm, max_cm::text AS max_cm, subject
     FROM measurement_definitions
     WHERE slug = $1`,
    [definition],
  );
  const row = found.rows[0];
  if (!row || row.subject !== "body" || !row.min_cm || !row.max_cm) {
    throw invalid("unknown_measurement", "That body measurement was not found.");
  }
  return row;
}

async function loadAccess(
  client: PoolClient,
  actorUserId: string,
  profileId: string,
): Promise<{ profile: ProfileRow; access: Access } | null> {
  const found = await client.query<ProfileRow>(
    `SELECT id, subject_user_id, name, notes, preferred_unit, status, created_at, updated_at
     FROM measurement_profiles
     WHERE id = $1`,
    [profileId],
  );
  const profile = found.rows[0];
  if (!profile) return null;
  if (profile.subject_user_id === actorUserId) return { profile, access: "subject" };
  const grant = await client.query<{ permission: Access }>(
    `SELECT permission FROM measurement_profile_grants
     WHERE profile_id = $1 AND grantee_user_id = $2 AND revoked_at IS NULL`,
    [profileId, actorUserId],
  );
  const permission = grant.rows[0]?.permission;
  if (!permission) return null;
  return { profile, access: permission };
}

async function lockProfile(client: PoolClient, actorUserId: string, profileId: string) {
  await client.query(`SELECT id FROM measurement_profiles WHERE id = $1 FOR UPDATE`, [profileId]);
  const loaded = await loadAccess(client, actorUserId, profileId);
  if (!loaded) throw notFound("Measurement profile was not found.");
  return loaded;
}

async function listRows(
  client: PoolClient,
  profileId: string,
  preferredUnit: MeasureUnit,
  definition: string | null,
  status: "current" | null,
): Promise<BodyMeasurementView[]> {
  const params: unknown[] = [profileId];
  const filters = ["measurement.profile_id = $1"];
  if (definition) {
    params.push(definition);
    filters.push(`definition.slug = $${params.length}`);
  }
  if (status) {
    params.push(status);
    filters.push(`measurement.record_status = $${params.length}`);
  }
  const found = await client.query<MeasurementRow>(
    `SELECT measurement.id, definition.slug AS definition, definition.name,
            measurement.entered_text, measurement.entered_unit, measurement.canonical_cm::text AS canonical_cm,
            measurement.source, measurement.verification_status, measurement.record_status, measurement.note,
            measurement.recorded_at, measurement.verified_at,
            recorder.display_name AS recorded_by, verifier.display_name AS verified_by
     FROM body_measurements AS measurement
     JOIN measurement_definitions AS definition ON definition.id = measurement.definition_id
     JOIN users AS recorder ON recorder.id = measurement.recorded_by_user_id
     LEFT JOIN users AS verifier ON verifier.id = measurement.verified_by_user_id
     WHERE ${filters.join(" AND ")}
     ORDER BY measurement.recorded_at DESC, measurement.id DESC`,
    params,
  );
  return found.rows.map((row) => measurementView(row, preferredUnit));
}

async function measurementById(client: PoolClient, measurementId: string, preferredUnit: MeasureUnit) {
  const found = await client.query<MeasurementRow>(
    `SELECT measurement.id, definition.slug AS definition, definition.name,
            measurement.entered_text, measurement.entered_unit, measurement.canonical_cm::text AS canonical_cm,
            measurement.source, measurement.verification_status, measurement.record_status, measurement.note,
            measurement.recorded_at, measurement.verified_at,
            recorder.display_name AS recorded_by, verifier.display_name AS verified_by
     FROM body_measurements AS measurement
     JOIN measurement_definitions AS definition ON definition.id = measurement.definition_id
     JOIN users AS recorder ON recorder.id = measurement.recorded_by_user_id
     LEFT JOIN users AS verifier ON verifier.id = measurement.verified_by_user_id
     WHERE measurement.id = $1`,
    [measurementId],
  );
  const row = found.rows[0];
  return row ? measurementView(row, preferredUnit) : null;
}

function measurementView(row: MeasurementRow, preferredUnit: MeasureUnit): BodyMeasurementView {
  return {
    id: row.id,
    definition: row.definition,
    name: row.name,
    enteredValue: row.entered_text,
    enteredUnit: row.entered_unit,
    canonicalCm: row.canonical_cm,
    displayValue: displayCanonical(row.canonical_cm, preferredUnit),
    displayUnit: preferredUnit,
    source: row.source,
    verificationStatus: row.verification_status,
    recordStatus: row.record_status,
    note: row.note,
    recordedAt: new Date(row.recorded_at).toISOString(),
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    recordedBy: { displayName: row.recorded_by },
    verifiedBy: row.verified_by ? { displayName: row.verified_by } : null,
  };
}

async function listGrants(client: PoolClient, profileId: string) {
  const found = await client.query<{ user_id: string; display_name: string; email: string; permission: string }>(
    `SELECT users.id AS user_id, users.display_name, users.email, grant_row.permission
     FROM measurement_profile_grants AS grant_row
     JOIN users ON users.id = grant_row.grantee_user_id
     WHERE grant_row.profile_id = $1 AND grant_row.revoked_at IS NULL
     ORDER BY users.display_name, users.id`,
    [profileId],
  );
  return found.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    permission: row.permission,
  }));
}

function viewProfile(
  profile: ProfileRow,
  access: Access,
  measurements: BodyMeasurementView[],
  grants: MeasurementProfileView["grants"],
): MeasurementProfileView {
  return {
    id: profile.id,
    name: profile.name,
    notes: profile.notes,
    preferredUnit: profile.preferred_unit,
    status: profile.status,
    access,
    fitAnalysis: false,
    imageExtraction: false,
    measurements,
    grants,
    createdAt: new Date(profile.created_at).toISOString(),
    updatedAt: new Date(profile.updated_at).toISOString(),
  };
}

function visibleSql(actor: string): string {
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

async function touchProfile(client: PoolClient, profileId: string) {
  await client.query(`UPDATE measurement_profiles SET notes = notes WHERE id = $1`, [profileId]);
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) throw invalid("invalid_name", "Enter a profile name up to 80 characters.");
  return name;
}

function cleanNotes(value: string): string {
  if (value.length > 500) throw invalid("invalid_notes", "Notes must be 500 characters or fewer.");
  return value.trim();
}

function cleanMeasurementNote(value: string): string {
  const note = value.trim();
  if (note.length > 240) throw invalid("invalid_notes", "The measurement note must be 240 characters or fewer.");
  return note;
}

function trimCm(value: string): string {
  return value.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
