import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool } from "../src/db/pool";
import { analyzeDimensions, describeFitRules } from "../src/modules/fit-rules";

const password = "fit-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Comparison = {
  bodyDefinition: string;
  garmentDefinition: string;
  bodyCm: string;
  garmentCm: string;
  differenceCm: string;
  bodySource: string;
  bodyVerification: string;
  size: { system: string; label: string } | null;
};

type Analysis = {
  id: string;
  classification: string;
  summary: string;
  easeApplied: boolean;
  fitGuarantee: boolean;
  fitPreference: null;
  comparisons: Comparison[];
  notes: { kind: string; message: string }[];
  dimensionalProximity: { size: { label: string }; message: string } | null;
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so fit tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so fit tests were not executed.");
  await migrate(pool);
  await removeFitFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeFitFixtures(pool);
  await closePool();
});

test("fit rules compare dimensions and do not apply an ease allowance", () => {
  const rules = describeFitRules();
  assert.equal(rules.easeRuleCount, 0);
  assert.equal(rules.fitGuarantee, false);
  const result = analyzeDimensions({
    garmentCategory: "shirt",
    comparisons: [
      comparison("chest-circumference", "chest", "90.00", "110.00"),
      comparison("waist-circumference", "waist", "80.00", "70.00"),
    ],
    missing: [],
    unmappedGarmentDefinitions: ["garment-length"],
    skippedAiDefinitions: [],
  });
  assert.equal(result.classification, "insufficient_data");
  assert.equal(result.easeApplied, false);
  assert.equal(result.fitGuarantee, false);
  assert.equal(result.comparisons[0]?.differenceCm, "20.00");
  assert.equal(result.comparisons[1]?.differenceCm, "-10.00");
  assert.equal(result.notes.some((note) => note.message.includes("ease allowance")), true);
  assert.equal(result.notes.some((note) => note.message.includes("same direction")), true);
  assert.equal(result.notes.some((note) => note.message.includes("stretch")), true);

  const flowing = analyzeDimensions({
    garmentCategory: "agbada",
    comparisons: [comparison("chest-circumference", "chest", "100.00", "180.00")],
    missing: [],
    unmappedGarmentDefinitions: [],
    skippedAiDefinitions: [],
  });
  assert.equal(flowing.classification, "unsupported_garment");
  assert.equal(flowing.comparisons[0]?.differenceCm, "80.00");
});

test("a shirt comparison stays explanatory when no ease rule exists", async () => {
  assert.ok(pool);
  const owner = await register("Owner");
  const tailor = await register("Tailor");
  const stranger = await register("Stranger");
  const anonymous = await request("POST", "/api/v1/fit/analyses", { body: {} });
  assert.equal(anonymous.status, 401);

  const rules = await request("GET", "/api/v1/fit/rules", { cookie: owner.cookie });
  assert.equal(rules.status, 200);
  assert.equal((rules.body as { rules: { easeRuleCount: number } }).rules.easeRuleCount, 0);

  const profileId = await profile(owner.cookie);
  await measure(owner.cookie, profileId, "chest-circumference", "32.5", "in");
  await measure(owner.cookie, profileId, "waist-circumference", "80", "cm");
  const shirtId = await garment(owner.cookie, "Measured shirt", "shirt", "M", [
    { definition: "chest", value: 90 },
    { definition: "waist", value: 70 },
    { definition: "garment-length", value: 72 },
  ]);
  const preferred = await request("POST", "/api/v1/fit/analyses", {
    cookie: owner.cookie,
    body: { profileId, garmentId: shirtId, fitPreference: "relaxed" },
  });
  assert.equal(preferred.status, 400);
  assert.equal((preferred.body as { error: { code: string } }).error.code, "unsupported_preference");

  const created = await request("POST", "/api/v1/fit/analyses", {
    cookie: owner.cookie,
    body: { profileId, garmentId: shirtId, size: { system: "letter", label: "M" } },
  });
  assert.equal(created.status, 201);
  const analysis = (created.body as { analysis: Analysis }).analysis;
  assert.equal(analysis.classification, "insufficient_data");
  assert.equal(analysis.easeApplied, false);
  assert.equal(analysis.fitGuarantee, false);
  assert.equal(analysis.fitPreference, null);
  const chest = analysis.comparisons.find((item) => item.bodyDefinition === "chest-circumference");
  const waist = analysis.comparisons.find((item) => item.bodyDefinition === "waist-circumference");
  assert.equal(chest?.bodyCm, "82.55");
  assert.equal(chest?.differenceCm, "7.45");
  assert.equal(chest?.bodySource, "user_entered");
  assert.equal(chest?.bodyVerification, "unverified");
  assert.equal(waist?.differenceCm, "-10.00");
  assert.equal(analysis.notes.some((note) => note.message.includes("Garment length")), true);
  assert.equal(analysis.notes.some((note) => note.message.includes("unverified")), true);
  assert.match(analysis.summary, /not classified/);

  await measure(owner.cookie, profileId, "chest-circumference", "95", "cm");
  const reread = await request("GET", `/api/v1/fit/analyses/${analysis.id}`, { cookie: owner.cookie });
  const kept = (reread.body as { analysis: Analysis }).analysis.comparisons.find((item) => item.bodyDefinition === "chest-circumference");
  assert.equal(kept?.bodyCm, "82.55");

  const hidden = await request("GET", `/api/v1/fit/analyses/${analysis.id}`, { cookie: stranger.cookie });
  assert.equal(hidden.status, 404);
  const foreignProfile = await request("POST", "/api/v1/fit/analyses", {
    cookie: stranger.cookie,
    body: { profileId, garmentId: shirtId },
  });
  assert.equal(foreignProfile.status, 404);
  const foreignGarment = await request("POST", "/api/v1/fit/analyses", {
    cookie: owner.cookie,
    body: { profileId, garmentId: randomUUID() },
  });
  assert.equal(foreignGarment.status, 404);

  await request("POST", `/api/v1/measurements/profiles/${profileId}/grants`, {
    cookie: owner.cookie,
    body: { email: tailor.email, permission: "read" },
  });
  const tailorRead = await request("GET", `/api/v1/fit/analyses/${analysis.id}`, { cookie: tailor.cookie });
  assert.equal(tailorRead.status, 404);

  const published = await request("PATCH", `/api/v1/catalog/garments/${shirtId}`, {
    cookie: owner.cookie,
    body: { visibility: "public" },
  });
  assert.equal(published.status, 200);
  const tailorAfter = await request("GET", `/api/v1/fit/analyses/${analysis.id}`, { cookie: tailor.cookie });
  assert.equal(tailorAfter.status, 200);
  const stillHidden = await request("GET", `/api/v1/fit/analyses/${analysis.id}`, { cookie: stranger.cookie });
  assert.equal(stillHidden.status, 404);
});

test("flowing garments, missing dimensions, and size labels stay distinct", async () => {
  assert.ok(pool);
  const owner = await register("Cutter");
  const profileId = await profile(owner.cookie);
  await measure(owner.cookie, profileId, "chest-circumference", "100", "cm");
  const agbadaId = await garment(owner.cookie, "Volume agbada", "agbada", "L", [{ definition: "chest", value: 180 }]);
  const flowing = await request("POST", "/api/v1/fit/analyses", {
    cookie: owner.cookie,
    body: { profileId, garmentId: agbadaId, size: { system: "letter", label: "L" } },
  });
  assert.equal(flowing.status, 201);
  const flowingView = (flowing.body as { analysis: Analysis }).analysis;
  assert.equal(flowingView.classification, "unsupported_garment");
  assert.equal(flowingView.comparisons[0]?.differenceCm, "80.00");
  assert.match(flowingView.summary, /not a judgment of fit/);

  const narrowId = await garment(owner.cookie, "Narrow M", "shirt", "M", [{ definition: "chest", value: 96 }]);
  const wideId = await garment(owner.cookie, "Wide M", "shirt", "M", [{ definition: "chest", value: 112 }]);
  const narrow = await analyze(owner.cookie, profileId, narrowId, "M");
  const wide = await analyze(owner.cookie, profileId, wideId, "M");
  assert.equal(narrow.comparisons[0]?.differenceCm, "-4.00");
  assert.equal(wide.comparisons[0]?.differenceCm, "12.00");
  assert.equal(narrow.classification, "insufficient_data");

  const unsized = await request("POST", "/api/v1/catalog/garments", {
    cookie: owner.cookie,
    body: { name: "Length only", terms: [{ kind: "garment_type", slug: "trousers" }] },
  });
  const trousersId = (unsized.body as { garment: { id: string } }).garment.id;
  await request("POST", `/api/v1/catalog/garments/${trousersId}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "garment-length", value: 104 },
  });
  const lengthOnly = await request("POST", "/api/v1/fit/analyses", {
    cookie: owner.cookie,
    body: { profileId, garmentId: trousersId },
  });
  assert.equal(lengthOnly.status, 201);
  const lengthView = (lengthOnly.body as { analysis: Analysis }).analysis;
  assert.equal(lengthView.comparisons.length, 0);
  assert.equal(lengthView.classification, "insufficient_data");
  assert.equal(lengthView.dimensionalProximity, null);

  const rankedId = await garment(owner.cookie, "Ranked shirt", "shirt", "M", [{ definition: "chest", value: 104 }]);
  await request("PATCH", `/api/v1/catalog/garments/${rankedId}`, {
    cookie: owner.cookie,
    body: { sizeLabels: [{ system: "letter", label: "M" }, { system: "letter", label: "L" }] },
  });
  await request("POST", `/api/v1/catalog/garments/${rankedId}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "chest", value: 108, size: { system: "letter", label: "L" } },
  });
  const ranked = await request("POST", "/api/v1/fit/analyses", {
    cookie: owner.cookie,
    body: { profileId, garmentId: rankedId },
  });
  const rankedView = (ranked.body as { analysis: Analysis }).analysis;
  assert.equal(rankedView.dimensionalProximity?.size.label, "M");
  assert.match(rankedView.dimensionalProximity?.message ?? "", /not a size recommendation/);

  await pool.query(
    `UPDATE body_measurements
     SET record_status = 'superseded'
     WHERE profile_id = $1 AND record_status = 'current'
       AND definition_id = (SELECT id FROM measurement_definitions WHERE slug = 'chest-circumference')`,
    [profileId],
  );
  await pool.query(
    `INSERT INTO body_measurements (
       profile_id, definition_id, entered_text, entered_value, entered_unit, canonical_cm,
       source, verification_status, recorded_by_user_id
     )
     SELECT $1, id, '90', 90, 'cm', 90, 'ai_estimated', 'unverified', $2
     FROM measurement_definitions WHERE slug = 'chest-circumference'`,
    [profileId, owner.id],
  );
  const estimated = await analyze(owner.cookie, profileId, narrowId, "M");
  assert.equal(estimated.comparisons.length, 0);
  assert.equal(estimated.notes.some((note) => note.message.includes("AI-estimated")), true);
});

test("measurement sources stay visible and a later edit does not rewrite history", async () => {
  assert.ok(pool);
  const owner = await register("Source");
  const tailor = await register("Recorder");
  const profileId = await profile(owner.cookie);
  const imported = await request("POST", `/api/v1/measurements/profiles/${profileId}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "hip-circumference", value: "98", unit: "cm", source: "imported" },
  });
  assert.equal(imported.status, 201);
  await request("POST", `/api/v1/measurements/profiles/${profileId}/grants`, {
    cookie: owner.cookie,
    body: { email: tailor.email, permission: "record" },
  });
  const recorded = await request("POST", `/api/v1/measurements/profiles/${profileId}/measurements`, {
    cookie: tailor.cookie,
    body: { definition: "waist-circumference", value: "76", unit: "cm", source: "tailor_recorded" },
  });
  assert.equal(recorded.status, 201);
  const measurementId = (recorded.body as { measurement: { id: string } }).measurement.id;
  await request("POST", `/api/v1/measurements/profiles/${profileId}/grants`, {
    cookie: owner.cookie,
    body: { email: tailor.email, permission: "verify" },
  });
  const verified = await request("POST", `/api/v1/measurements/profiles/${profileId}/measurements/${measurementId}/verify`, {
    cookie: tailor.cookie,
  });
  assert.equal(verified.status, 200);
  const shirtId = await garment(owner.cookie, "Source shirt", "shirt", "S", [
    { definition: "waist", value: 82 },
    { definition: "hip", value: 102 },
  ]);
  await request("PATCH", `/api/v1/catalog/garments/${shirtId}`, { cookie: owner.cookie, body: { visibility: "public" } });
  const analysis = await analyze(owner.cookie, profileId, shirtId, "S");
  const waist = analysis.comparisons.find((item) => item.bodyDefinition === "waist-circumference");
  const hip = analysis.comparisons.find((item) => item.bodyDefinition === "hip-circumference");
  assert.equal(waist?.bodySource, "tailor_recorded");
  assert.equal(waist?.bodyVerification, "verified");
  assert.equal(waist?.differenceCm, "6.00");
  assert.equal(hip?.bodySource, "imported");
  assert.equal(hip?.bodyVerification, "unverified");
  assert.equal(analysis.classification, "insufficient_data");
  assert.equal(analysis.notes.some((note) => note.message.includes("imported")), true);
  assert.equal(analysis.notes.some((note) => note.message.includes("requires verification")), false);

  const history = await request("GET", `/api/v1/fit/analyses?profileId=${profileId}`, { cookie: tailor.cookie });
  assert.equal(history.status, 200);
  assert.equal((history.body as { analyses: Analysis[] }).analyses.some((item) => item.id === analysis.id), true);
  const stranger = await register("History");
  const denied = await request("GET", "/api/v1/fit/analyses", { cookie: stranger.cookie });
  assert.equal(denied.status, 200);
  assert.equal((denied.body as { analyses: Analysis[] }).analyses.length, 0);
});

function comparison(bodyDefinition: string, garmentDefinition: string, bodyCm: string, garmentCm: string) {
  return {
    size: { system: "letter", label: "M" },
    bodyDefinition,
    garmentDefinition,
    bodyCm,
    garmentCm,
    bodySource: "user_entered",
    bodyVerification: "unverified" as const,
    bodyRecordedAt: "2026-01-01T00:00:00.000Z",
    garmentProvenance: "stated",
  };
}

async function analyze(cookie: string, profileId: string, garmentId: string, label: string): Promise<Analysis> {
  const response = await request("POST", "/api/v1/fit/analyses", {
    cookie,
    body: { profileId, garmentId, size: { system: "letter", label } },
  });
  assert.equal(response.status, 201);
  return (response.body as { analysis: Analysis }).analysis;
}

async function profile(cookie: string): Promise<string> {
  const response = await request("POST", "/api/v1/measurements/profiles", {
    cookie,
    body: { name: "Fit profile", preferredUnit: "cm" },
  });
  assert.equal(response.status, 201);
  return (response.body as { profile: { id: string } }).profile.id;
}

async function measure(cookie: string, profileId: string, definition: string, value: string, unit: string) {
  const response = await request("POST", `/api/v1/measurements/profiles/${profileId}/measurements`, {
    cookie,
    body: { definition, value, unit, source: "user_entered" },
  });
  assert.equal(response.status, 201);
}

async function garment(
  cookie: string,
  name: string,
  type: string,
  label: string,
  dimensions: { definition: string; value: number }[],
): Promise<string> {
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie,
    body: { name, terms: [{ kind: "garment_type", slug: type }], sizeLabels: [{ system: "letter", label }] },
  });
  assert.equal(created.status, 201);
  const id = (created.body as { garment: { id: string } }).garment.id;
  for (const dimension of dimensions) {
    const measured = await request("POST", `/api/v1/catalog/garments/${id}/measurements`, {
      cookie,
      body: { ...dimension, size: { system: "letter", label } },
    });
    assert.equal(measured.status, 201);
  }
  return id;
}

async function register(displayName: string): Promise<{ id: string; email: string; cookie: string }> {
  const email = `${randomUUID()}@fit.test`;
  const response = await request("POST", "/api/v1/auth/register", { body: { email, displayName, password } });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, email, cookie: `bop_session=${token[1]}` };
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

async function removeFitFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@fit.test')`;
  await active.query(
    `DELETE FROM fit_analyses
     WHERE profile_id IN (SELECT id FROM measurement_profiles WHERE subject_user_id IN ${owners})
        OR garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`,
  );
  await active.query(`DELETE FROM measurement_profiles WHERE subject_user_id IN ${owners}`);
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garments WHERE created_by_user_id IN ${owners}`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@fit.test'`);
}
