import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool, withTransaction } from "../src/db/pool";
import { convertMeasurement, displayCanonical } from "../src/modules/measure-units";
import { addMember, createOrganization } from "../src/modules/organizations";

const password = "measure-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Measurement = {
  id: string;
  definition: string;
  enteredValue: string;
  enteredUnit: string;
  canonicalCm: string;
  displayValue: string;
  displayUnit: string;
  source: string;
  verificationStatus: string;
  recordStatus: string;
  note: string;
};

type Profile = {
  id: string;
  name: string;
  preferredUnit: string;
  status: string;
  access: string;
  fitAnalysis: boolean;
  imageExtraction: boolean;
  measurements: Measurement[];
  grants: { userId: string; email: string; permission: string }[];
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so measurement tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so measurement tests were not executed.");
  await migrate(pool);
  await removeMeasurementFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeMeasurementFixtures(pool);
  await closePool();
});

test("length conversion keeps the entered value and rounds half up to centimetres", () => {
  assert.deepEqual(convertMeasurement("32.5", "in"), { enteredText: "32.5", canonicalCm: "82.55" });
  assert.equal(convertMeasurement("10.25", "in").canonicalCm, "26.04");
  assert.equal(convertMeasurement("1.625", "m").canonicalCm, "162.50");
  assert.equal(convertMeasurement("90", "cm").canonicalCm, "90.00");
  assert.equal(displayCanonical("82.55", "in"), "32.50");
  assert.equal(displayCanonical("26.04", "in"), "10.25");
  assert.equal(displayCanonical("162.50", "m"), "1.625");
});

test("a person can record body measurements without exposing them to an organization", async () => {
  assert.ok(pool);
  const owner = await register("Owner");
  const tailor = await register("Tailor");
  const colleague = await register("Colleague");
  const anonymous = await request("GET", "/api/v1/measurements/profiles");
  assert.equal(anonymous.status, 401);

  const described = await request("GET", "/api/v1/measurements/definitions", { cookie: owner.cookie });
  const definitions = (described.body as { definitions: { slug: string }[]; imageExtraction: boolean; fitAnalysis: boolean }).definitions;
  assert.equal(described.status, 200);
  assert.equal((described.body as { imageExtraction: boolean }).imageExtraction, false);
  assert.equal((described.body as { fitAnalysis: boolean }).fitAnalysis, false);
  assert.equal(definitions.some((item) => item.slug === "chest-circumference"), true);
  assert.equal(definitions.some((item) => item.slug === "chest"), false);

  const created = await request("POST", "/api/v1/measurements/profiles", {
    cookie: owner.cookie,
    body: { name: "General", preferredUnit: "in", notes: "Personal tailoring" },
  });
  assert.equal(created.status, 201);
  const profile = (created.body as { profile: Profile }).profile;
  assert.equal(profile.measurements.length, 0);
  assert.equal(profile.fitAnalysis, false);
  assert.equal(profile.preferredUnit, "in");

  const blocked = await request("POST", "/api/v1/measurements/profiles", {
    cookie: owner.cookie,
    body: { name: "Shared", organizationId: randomUUID() },
  });
  assert.equal(blocked.status, 400);

  const missing = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { value: "80", unit: "cm", source: "user_entered" },
  });
  assert.equal(missing.status, 400);
  const badValue = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "waist-circumference", value: "0", unit: "cm", source: "user_entered" },
  });
  assert.equal(badValue.status, 400);
  const badUnit = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "waist-circumference", value: "80", unit: "ft", source: "user_entered" },
  });
  assert.equal(badUnit.status, 400);
  const tooSmall = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "neck-circumference", value: "19", unit: "cm", source: "user_entered" },
  });
  assert.equal(tooSmall.status, 400);
  const estimated = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "waist-circumference", value: "80", unit: "cm", source: "ai_estimated" },
  });
  assert.equal(estimated.status, 400);
  assert.equal((estimated.body as { error: { code: string } }).error.code, "unsupported_source");
  const claimed = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "waist-circumference", value: "80", unit: "cm", source: "professionally_verified" },
  });
  assert.equal(claimed.status, 400);
  assert.equal((claimed.body as { error: { code: string } }).error.code, "unsupported_verification");

  const recorded = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "waist-circumference", value: "32.5", unit: "in", source: "user_entered", note: "Tape at the waist" },
  });
  assert.equal(recorded.status, 201);
  const current = (recorded.body as { measurement: Measurement }).measurement;
  assert.equal(current.enteredValue, "32.5");
  assert.equal(current.enteredUnit, "in");
  assert.equal(current.canonicalCm, "82.55");
  assert.equal(current.displayValue, "32.50");
  assert.equal(current.displayUnit, "in");
  assert.equal(current.source, "user_entered");
  assert.equal(current.verificationStatus, "unverified");
  assert.equal(JSON.stringify(recorded.body).includes("confidence"), false);

  const corrected = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: owner.cookie,
    body: { definition: "waist-circumference", value: "83", unit: "cm", source: "user_entered", note: "Corrected" },
  });
  assert.equal(corrected.status, 201);
  const history = await request("GET", `/api/v1/measurements/profiles/${profile.id}/history?definition=waist-circumference`, {
    cookie: owner.cookie,
  });
  const rows = (history.body as { measurements: Measurement[] }).measurements;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.recordStatus, "current");
  assert.equal(rows[0]?.enteredValue, "83");
  assert.equal(rows[1]?.recordStatus, "superseded");
  assert.equal(rows[1]?.enteredValue, "32.5");

  const hidden = await request("GET", `/api/v1/measurements/profiles/${profile.id}`, { cookie: tailor.cookie });
  assert.equal(hidden.status, 404);
  await withTransaction(async (client) => {
    const organization = await createOrganization(client, owner.id, {
      name: "Measure tailor",
      slug: `measure-test-${randomUUID().slice(0, 8)}`,
      kind: "tailor",
    });
    await addMember(client, owner.id, { organizationId: organization.id, userId: colleague.id, role: "member" });
  });
  const orgHidden = await request("GET", `/api/v1/measurements/profiles/${profile.id}`, { cookie: colleague.cookie });
  assert.equal(orgHidden.status, 404);

  const granted = await request("POST", `/api/v1/measurements/profiles/${profile.id}/grants`, {
    cookie: owner.cookie,
    body: { email: tailor.email, permission: "read" },
  });
  assert.equal(granted.status, 201);
  const reader = await request("GET", `/api/v1/measurements/profiles/${profile.id}`, { cookie: tailor.cookie });
  assert.equal(reader.status, 200);
  assert.equal((reader.body as { profile: Profile }).profile.grants.length, 0);
  const tailorWrite = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: tailor.cookie,
    body: { definition: "hip-circumference", value: "96", unit: "cm", source: "tailor_recorded" },
  });
  assert.equal(tailorWrite.status, 400);

  const recordGrant = await request("POST", `/api/v1/measurements/profiles/${profile.id}/grants`, {
    cookie: owner.cookie,
    body: { email: tailor.email, permission: "record" },
  });
  assert.equal(recordGrant.status, 200);
  const tailorRecorded = await request("POST", `/api/v1/measurements/profiles/${profile.id}/measurements`, {
    cookie: tailor.cookie,
    body: { definition: "hip-circumference", value: "96", unit: "cm", source: "tailor_recorded" },
  });
  assert.equal(tailorRecorded.status, 201);
  assert.equal((tailorRecorded.body as { measurement: Measurement }).measurement.source, "tailor_recorded");
  assert.equal((tailorRecorded.body as { measurement: Measurement }).measurement.verificationStatus, "unverified");
  const selfVerify = await request(
    "POST",
    `/api/v1/measurements/profiles/${profile.id}/measurements/${current.id}/verify`,
    { cookie: owner.cookie },
  );
  assert.equal(selfVerify.status, 400);

  const verifyGrant = await request("POST", `/api/v1/measurements/profiles/${profile.id}/grants`, {
    cookie: owner.cookie,
    body: { email: tailor.email, permission: "verify" },
  });
  assert.equal(verifyGrant.status, 200);
  const verified = await request(
    "POST",
    `/api/v1/measurements/profiles/${profile.id}/measurements/${(corrected.body as { measurement: Measurement }).measurement.id}/verify`,
    { cookie: tailor.cookie },
  );
  assert.equal(verified.status, 200);
  assert.equal((verified.body as { measurement: Measurement }).measurement.verificationStatus, "verified");
  assert.equal((verified.body as { measurement: Measurement }).measurement.source, "user_entered");

  const archived = await request(
    "POST",
    `/api/v1/measurements/profiles/${profile.id}/measurements/${(corrected.body as { measurement: Measurement }).measurement.id}/archive`,
    { cookie: owner.cookie },
  );
  assert.equal(archived.status, 200);
  assert.equal((archived.body as { measurement: Measurement }).measurement.recordStatus, "archived");
  const afterArchive = await request("GET", `/api/v1/measurements/profiles/${profile.id}/history?definition=waist-circumference`, {
    cookie: owner.cookie,
  });
  const kept = (afterArchive.body as { measurements: Measurement[] }).measurements;
  assert.equal(kept.some((item) => item.enteredValue === "32.5" && item.recordStatus === "superseded"), true);
  assert.equal(kept.some((item) => item.enteredValue === "83" && item.recordStatus === "archived"), true);

  await request("DELETE", `/api/v1/measurements/profiles/${profile.id}/grants/${tailor.id}`, { cookie: owner.cookie });
  const revoked = await request("GET", `/api/v1/measurements/profiles/${profile.id}`, { cookie: tailor.cookie });
  assert.equal(revoked.status, 404);
});

test("garment dimensions stay separate from body measurements and size labels", async () => {
  const maker = await register("Cutter");
  const stranger = await register("Stranger");
  const garment = await request("POST", "/api/v1/catalog/garments", {
    cookie: maker.cookie,
    body: { name: "Measured shirt", sizeLabels: [{ system: "letter", label: "M" }] },
  });
  assert.equal(garment.status, 201);
  const garmentId = (garment.body as { garment: { id: string } }).garment.id;
  const bodyOnGarment = await request("POST", `/api/v1/catalog/garments/${garmentId}/measurements`, {
    cookie: maker.cookie,
    body: { definition: "chest-circumference", value: 96 },
  });
  assert.equal(bodyOnGarment.status, 400);
  assert.equal((bodyOnGarment.body as { error: { code: string } }).error.code, "wrong_subject");

  const inches = await request("POST", `/api/v1/catalog/garments/${garmentId}/measurements`, {
    cookie: maker.cookie,
    body: { definition: "chest", value: 32, unit: "in", size: { system: "letter", label: "M" } },
  });
  assert.equal(inches.status, 201);
  const stored = (inches.body as { garment: { measurements: { definition: string; value: string; enteredValue: string; enteredUnit: string; sizeLabel: string | null; provenance: string }[] } }).garment.measurements[0];
  assert.ok(stored);
  assert.equal(stored.definition, "chest");
  assert.equal(Number(stored.value), 81.28);
  assert.equal(stored.enteredValue, "32");
  assert.equal(stored.enteredUnit, "in");
  assert.equal(stored.sizeLabel, "M");
  assert.equal(stored.provenance, "stated");

  const denied = await request("POST", `/api/v1/catalog/garments/${garmentId}/measurements`, {
    cookie: stranger.cookie,
    body: { definition: "garment-length", value: 70 },
  });
  assert.equal(denied.status, 404);
  const missingGarment = await request("POST", `/api/v1/catalog/garments/${randomUUID()}/measurements`, {
    cookie: maker.cookie,
    body: { definition: "garment-length", value: 70 },
  });
  assert.equal(missingGarment.status, 404);
});

async function register(displayName: string): Promise<{ id: string; email: string; cookie: string }> {
  const email = `${randomUUID()}@measure.test`;
  const response = await request("POST", "/api/v1/auth/register", {
    body: { email, displayName, password },
  });
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

async function removeMeasurementFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@measure.test')`;
  await active.query(`DELETE FROM measurement_profiles WHERE subject_user_id IN ${owners} OR created_by_user_id IN ${owners}`);
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garments WHERE created_by_user_id IN ${owners}`);
  await active.query(`DELETE FROM organization_memberships WHERE user_id IN ${owners}`);
  await active.query(`DELETE FROM organizations WHERE slug LIKE 'measure-test-%'`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@measure.test'`);
}
