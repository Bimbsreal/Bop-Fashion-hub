import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { closePool, getPool } from "../src/db/pool";
import { recommendOutfits, type StyleGarment, type StyleTerm } from "../src/modules/style-rules";

const password = "style-pass-1";
let pool: Pool | null = null;
let server: Server | null = null;
let baseUrl = "";

type Note = { kind: string; message: string };
type Session = {
  id: string;
  status: string;
  summary: string;
  fashionQualityScore: boolean;
  recommendations: {
    id: string;
    ruleMatchCount: number;
    items: { garmentId: string; name: string | null; role: string }[];
    notes: Note[];
    rejected: boolean;
  }[];
};

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set, so style tests were not executed.");
  pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set, so style tests were not executed.");
  await migrate(pool);
  await removeStyleFixtures(pool);
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  }
  if (pool) await removeStyleFixtures(pool);
  await closePool();
});

test("style rules explain catalog matches and do not invent a quality score", () => {
  const shirt = piece("shirt-1", "Ivory shirt", "shirt", [term("color", "ivory", "Ivory"), term("style", "casual", "Casual")]);
  const trousers = piece("trousers-1", "Black trousers", "trousers", [term("color", "black", "Black"), term("style", "formal", "Formal")]);
  const result = recommendOutfits({
    garments: [shirt, trousers],
    preferences: [],
    occasion: null,
    style: null,
    anchorId: null,
    poolLimited: false,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.recommendations[0]?.notes.some((note) => note.message.includes("neutral color rule")), true);
  assert.equal(result.recommendations[0]?.notes.some((note) => note.message.includes("Mixed styles were kept")), true);
  assert.equal(result.recommendations[0]?.notes.some((note) => note.message.includes("preferred")), false);
  assert.equal(result.summary.includes("fashion-quality"), true);

  const gold = piece("shirt-2", "Gold shirt", "shirt", [term("color", "gold", "Gold")]);
  const indigo = piece("trousers-2", "Indigo trousers", "trousers", [term("color", "indigo", "Indigo")]);
  const unknown = recommendOutfits({
    garments: [gold, indigo],
    preferences: [],
    occasion: null,
    style: null,
    anchorId: null,
    poolLimited: false,
  });
  assert.equal(unknown.status, "completed");
  assert.equal(unknown.recommendations[0]?.notes.some((note) => note.message.includes("not rejected for color")), true);

  const agbada = piece("agbada-1", "Volume agbada", "agbada", [term("material", "aso-oke", "Aso Oke")]);
  const flowing = recommendOutfits({
    garments: [agbada],
    preferences: [{ polarity: "preferred", kind: "material", slug: "aso-oke" }],
    occasion: null,
    style: null,
    anchorId: "agbada-1",
    poolLimited: false,
  });
  assert.equal(flowing.recommendations[0]?.items[0]?.role, "one_piece");
  assert.equal(flowing.recommendations[0]?.notes.some((note) => note.message.includes("preferred material Aso Oke")), true);
  assert.equal(flowing.recommendations[0]?.notes.some((note) => note.message.includes("No ceremonial")), true);
  assert.equal(flowing.recommendations.some((item) => item.items.some((pieceItem) => pieceItem.role === "outerwear")), false);

  const plain = piece("shirt-3", "Plain shirt", "shirt", []);
  const missing = recommendOutfits({
    garments: [plain, trousers],
    preferences: [],
    occasion: null,
    style: null,
    anchorId: null,
    poolLimited: false,
  });
  assert.equal(missing.recommendations.some((item) => item.items.some((pieceItem) => pieceItem.garmentId === "shirt-3")), true);

  const blocked = recommendOutfits({
    garments: [shirt, trousers],
    preferences: [{ polarity: "disliked", kind: "color", slug: "black" }],
    occasion: null,
    style: null,
    anchorId: null,
    poolLimited: false,
  });
  assert.equal(blocked.status, "insufficient_data");
});

test("styling preferences stay on the signed-in person", async () => {
  const owner = await register("Stylist");
  const stranger = await register("Guest");
  const anonymous = await request("GET", "/api/v1/style/profile");
  assert.equal(anonymous.status, 401);
  const saved = await request("PUT", "/api/v1/style/profile", {
    cookie: owner.cookie,
    body: {
      notes: "Warm neutrals",
      preferences: [
        { polarity: "preferred", kind: "color", slug: "ivory" },
        { polarity: "preferred", kind: "style", slug: "casual" },
        { polarity: "disliked", kind: "color", slug: "indigo" },
      ],
    },
  });
  assert.equal(saved.status, 200);
  const unknown = await request("PUT", "/api/v1/style/profile", {
    cookie: owner.cookie,
    body: { preferences: [{ polarity: "preferred", kind: "occasion", slug: "wedding" }] },
  });
  assert.equal(unknown.status, 400);
  const budget = await request("POST", "/api/v1/style/sessions", {
    cookie: owner.cookie,
    body: { budget: { min: 1, max: 2 } },
  });
  assert.equal(budget.status, 400);
  const cleared = await request("DELETE", "/api/v1/style/profile", { cookie: owner.cookie });
  assert.equal(cleared.status, 200);
  assert.equal((cleared.body as { profile: { preferences: unknown[] } }).profile.preferences.length, 0);
  const hidden = await request("GET", "/api/v1/style/profile", { cookie: stranger.cookie });
  assert.equal((hidden.body as { profile: { notes: string } }).profile.notes, "");
});

test("recommendations cite real tags and keep private garments out", async () => {
  const owner = await register("Maker");
  const stranger = await register("Reader");
  await request("PUT", "/api/v1/style/profile", {
    cookie: owner.cookie,
    body: { preferences: [{ polarity: "preferred", kind: "material", slug: "ankara" }] },
  });
  const shirtId = await garment(owner.cookie, "Ankara shirt", "shirt", [
    { kind: "color", slug: "gold" },
    { kind: "material", slug: "ankara" },
    { kind: "style", slug: "contemporary-african" },
  ]);
  const trouserId = await garment(owner.cookie, "Ivory trousers", "trousers", [
    { kind: "color", slug: "ivory" },
    { kind: "style", slug: "contemporary-african" },
  ]);
  const privateId = await garment(stranger.cookie, "Hidden shirt", "shirt", [{ kind: "color", slug: "black" }]);
  const session = await request("POST", "/api/v1/style/sessions", {
    cookie: owner.cookie,
    body: { style: "contemporary-african", anchorGarmentId: shirtId },
  });
  assert.equal(session.status, 201);
  const view = (session.body as { session: Session }).session;
  assert.equal(view.status, "completed");
  assert.equal(view.fashionQualityScore, false);
  const outfit = view.recommendations.find((item) => item.items.some((pieceItem) => pieceItem.garmentId === trouserId));
  assert.ok(outfit);
  assert.equal(outfit.items.some((item) => item.garmentId === shirtId), true);
  assert.equal(outfit.items.some((item) => item.garmentId === privateId), false);
  assert.equal(outfit.notes.some((note) => note.message.includes("Ankara")), true);
  assert.equal(outfit.notes.some((note) => note.message.includes("preferred material Ankara")), true);
  assert.equal(outfit.notes.some((note) => note.message.includes("accent-with-neutral")), true);
  const empty = await request("POST", "/api/v1/style/sessions", { cookie: stranger.cookie, body: { source: "wardrobe" } });
  assert.equal((empty.body as { session: Session }).session.status, "insufficient_data");
  const foreign = await request("GET", `/api/v1/style/sessions/${view.id}`, { cookie: stranger.cookie });
  assert.equal(foreign.status, 404);
});

test("outfits and wardrobe stay with their owner", async () => {
  const owner = await register("Wearer");
  const stranger = await register("Other");
  const shirtId = await garment(owner.cookie, "White shirt", "shirt", [{ kind: "color", slug: "white" }]);
  const firstTrousers = await garment(owner.cookie, "Black trousers", "trousers", [{ kind: "color", slug: "black" }]);
  const secondTrousers = await garment(owner.cookie, "Ivory trousers", "trousers", [{ kind: "color", slug: "ivory" }]);
  const created = await request("POST", "/api/v1/style/outfits", {
    cookie: owner.cookie,
    body: {
      name: "Day board",
      items: [
        { garmentId: shirtId, role: "top" },
        { garmentId: firstTrousers, role: "bottom" },
      ],
    },
  });
  assert.equal(created.status, 201);
  const outfitId = (created.body as { outfit: { id: string; preview: string } }).outfit.id;
  assert.equal((created.body as { outfit: { preview: string } }).outfit.preview, "catalog_board");
  const duplicate = await request("PUT", `/api/v1/style/outfits/${outfitId}/items`, {
    cookie: owner.cookie,
    body: { garmentId: shirtId, role: "bottom" },
  });
  assert.equal(duplicate.status, 400);
  const replaced = await request("PUT", `/api/v1/style/outfits/${outfitId}/items`, {
    cookie: owner.cookie,
    body: { garmentId: secondTrousers, role: "bottom" },
  });
  assert.equal(replaced.status, 200);
  const bottoms = (replaced.body as { outfit: { items: { garmentId: string; role: string }[] } }).outfit.items.filter(
    (item) => item.role === "bottom",
  );
  assert.equal(bottoms.length, 1);
  assert.equal(bottoms[0]?.garmentId, secondTrousers);
  const removed = await request("DELETE", `/api/v1/style/outfits/${outfitId}/items/bottom`, { cookie: owner.cookie });
  assert.equal(removed.status, 200);
  const renamed = await request("PATCH", `/api/v1/style/outfits/${outfitId}`, {
    cookie: owner.cookie,
    body: { name: "Edited board", notes: "Separate photos" },
  });
  assert.equal(renamed.status, 200);
  const hidden = await request("GET", `/api/v1/style/outfits/${outfitId}`, { cookie: stranger.cookie });
  assert.equal(hidden.status, 404);
  const denied = await request("POST", "/api/v1/style/outfits", {
    cookie: stranger.cookie,
    body: { name: "Borrowed", items: [{ garmentId: shirtId, role: "top" }] },
  });
  assert.equal(denied.status, 404);
  const added = await request("POST", "/api/v1/style/wardrobe", { cookie: owner.cookie, body: { garmentId: shirtId } });
  assert.equal(added.status, 201);
  assert.equal((added.body as { item: { ownershipRecorded: boolean } }).item.ownershipRecorded, false);
  const wardrobe = await request("GET", "/api/v1/style/wardrobe", { cookie: owner.cookie });
  assert.equal((wardrobe.body as { wardrobe: { items: { garmentId: string }[] } }).wardrobe.items.length, 1);
  const removedItem = await request("DELETE", `/api/v1/style/wardrobe/${shirtId}`, { cookie: owner.cookie });
  assert.equal(removedItem.status, 200);
  assert.equal((removedItem.body as { item: { catalogRemains: boolean } }).item.catalogRemains, true);
  const stillThere = await request("GET", `/api/v1/catalog/garments/${shirtId}`, { cookie: owner.cookie });
  assert.equal(stillThere.status, 200);
  const strangerWardrobe = await request("DELETE", `/api/v1/style/wardrobe/${shirtId}`, { cookie: stranger.cookie });
  assert.equal(strangerWardrobe.status, 404);
});

function term(kind: string, slug: string, name: string): StyleTerm {
  return { kind, slug, name };
}

function piece(id: string, name: string, typeSlug: string, terms: StyleTerm[]): StyleGarment {
  return { id, name, typeSlug, terms };
}

async function garment(
  cookie: string,
  name: string,
  type: string,
  extra: { kind: string; slug: string }[],
): Promise<string> {
  const created = await request("POST", "/api/v1/catalog/garments", {
    cookie,
    body: { name, terms: [{ kind: "garment_type", slug: type }, ...extra] },
  });
  assert.equal(created.status, 201);
  return (created.body as { garment: { id: string } }).garment.id;
}

async function register(displayName: string): Promise<{ id: string; cookie: string }> {
  const email = `${randomUUID()}@style.test`;
  const response = await request("POST", "/api/v1/auth/register", { body: { email, displayName, password } });
  assert.equal(response.status, 201);
  const token = response.headers.get("set-cookie")?.match(/bop_session=([^;]+)/);
  assert.ok(token);
  return { id: (response.body as { user: { id: string } }).user.id, cookie: `bop_session=${token[1]}` };
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

async function removeStyleFixtures(active: Pool) {
  const owners = `(SELECT id FROM users WHERE email LIKE '%@style.test')`;
  await active.query(`DELETE FROM styling_sessions WHERE user_id IN ${owners}`);
  await active.query(`DELETE FROM outfits WHERE owner_user_id IN ${owners}`);
  await active.query(`DELETE FROM wardrobe_items WHERE user_id IN ${owners}`);
  await active.query(`DELETE FROM garment_measurements WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_size_labels WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_terms WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garment_media WHERE garment_id IN (SELECT id FROM garments WHERE created_by_user_id IN ${owners})`);
  await active.query(`DELETE FROM garments WHERE created_by_user_id IN ${owners}`);
  await active.query(`DELETE FROM users WHERE email LIKE '%@style.test'`);
}
