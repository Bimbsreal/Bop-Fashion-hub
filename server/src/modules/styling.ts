import type { PoolClient } from "pg";
import { DomainError, invalid, notFound } from "../errors";
import { getCatalogGarment } from "./fashion";
import {
  describeStyleRules,
  explainAlternative,
  outfitRoleForType,
  recommendOutfits,
  styleRuleSetId,
  type OutfitRole,
  type StyleGarment,
  type StyleNote,
  type StyleTerm,
} from "./style-rules";

const preferenceKinds = new Set(["style", "color", "occasion", "garment_type", "material", "tradition", "category"]);
const roles = new Set<OutfitRole>(["top", "bottom", "one_piece", "outerwear"]);

type PreferenceView = { polarity: "preferred" | "disliked"; kind: string; slug: string; name: string };
type ItemView = {
  garmentId: string;
  role: OutfitRole;
  available: boolean;
  name: string | null;
  typeSlug: string | null;
  terms: StyleTerm[];
  mediaId: string | null;
};

export function styleRuleDescription() {
  return describeStyleRules();
}

export async function listStyleVocabulary(client: PoolClient) {
  const found = await client.query<StyleTerm>(
    `SELECT kind, slug, name FROM fashion_terms
     WHERE kind = ANY($1::text[])
     ORDER BY kind, name`,
    [[...preferenceKinds]],
  );
  const grouped: Record<string, StyleTerm[]> = {};
  for (const kind of preferenceKinds) grouped[kind] = [];
  for (const row of found.rows) {
    const list = grouped[row.kind] ?? [];
    list.push(row);
    grouped[row.kind] = list;
  }
  return {
    terms: grouped,
    occasionVocabulary: (grouped.occasion?.length ?? 0) > 0 ? "available" : "empty",
    budgetSupported: false,
  };
}

export async function getStylingProfile(client: PoolClient, actorUserId: string) {
  const profile = await client.query<{ notes: string; updated_at: Date }>(
    `SELECT notes, updated_at FROM styling_profiles WHERE user_id = $1`,
    [actorUserId],
  );
  const preferences = await preferenceRows(client, actorUserId);
  return {
    notes: profile.rows[0]?.notes ?? "",
    preferences,
    updatedAt: profile.rows[0] ? profile.rows[0].updated_at.toISOString() : null,
  };
}

export async function replaceStylingProfile(
  client: PoolClient,
  actorUserId: string,
  input: { notes: string; preferences: { polarity: string; kind: string; slug: string }[] },
) {
  const notes = input.notes.trim();
  if (notes.length > 500) throw invalid("invalid_notes", "Notes are too long.");
  if (input.preferences.length > 24) throw invalid("invalid_preference", "Save up to 24 preferences.");
  const seen = new Set<string>();
  const resolved: { polarity: "preferred" | "disliked"; termId: string }[] = [];
  for (const preference of input.preferences) {
    if (preference.polarity !== "preferred" && preference.polarity !== "disliked") {
      throw invalid("invalid_preference", "A preference is either preferred or disliked.");
    }
    if (!preferenceKinds.has(preference.kind)) throw invalid("invalid_preference", "That preference kind is not supported.");
    const key = `${preference.polarity}:${preference.kind}:${preference.slug}`;
    if (seen.has(key)) throw invalid("invalid_preference", "That preference is listed twice.");
    seen.add(key);
    const opposite = `${preference.polarity === "preferred" ? "disliked" : "preferred"}:${preference.kind}:${preference.slug}`;
    if (seen.has(opposite)) throw invalid("invalid_preference", "The same term cannot be preferred and disliked.");
    const term = await client.query<{ id: string }>(
      `SELECT id FROM fashion_terms WHERE kind = $1 AND slug = $2`,
      [preference.kind, preference.slug],
    );
    const termId = term.rows[0]?.id;
    if (!termId) throw invalid("unknown_term", "That styling term was not found.");
    resolved.push({ polarity: preference.polarity, termId });
  }
  await client.query(
    `INSERT INTO styling_profiles (user_id, notes, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()`,
    [actorUserId, notes],
  );
  await client.query(`DELETE FROM styling_preferences WHERE user_id = $1`, [actorUserId]);
  for (const preference of resolved) {
    await client.query(`INSERT INTO styling_preferences (user_id, polarity, term_id) VALUES ($1, $2, $3)`, [
      actorUserId,
      preference.polarity,
      preference.termId,
    ]);
  }
  return getStylingProfile(client, actorUserId);
}

export async function clearStylingPreferences(client: PoolClient, actorUserId: string) {
  await client.query(
    `INSERT INTO styling_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [actorUserId],
  );
  await client.query(`DELETE FROM styling_preferences WHERE user_id = $1`, [actorUserId]);
  await client.query(`UPDATE styling_profiles SET notes = '', updated_at = now() WHERE user_id = $1`, [actorUserId]);
  return getStylingProfile(client, actorUserId);
}

export async function addWardrobeItem(client: PoolClient, actorUserId: string, garmentId: string) {
  await getCatalogGarment(client, actorUserId, garmentId);
  await client.query(
    `INSERT INTO wardrobe_items (user_id, garment_id) VALUES ($1, $2)
     ON CONFLICT (user_id, garment_id) DO NOTHING`,
    [actorUserId, garmentId],
  );
  return { garmentId, wardrobe: true, ownershipRecorded: false };
}

export async function removeWardrobeItem(client: PoolClient, actorUserId: string, garmentId: string) {
  const removed = await client.query(`DELETE FROM wardrobe_items WHERE user_id = $1 AND garment_id = $2`, [
    actorUserId,
    garmentId,
  ]);
  if (!removed.rowCount) throw notFound("That wardrobe item was not found.");
  const still = await client.query(`SELECT id FROM garments WHERE id = $1`, [garmentId]);
  return { garmentId, removed: true, catalogRemains: still.rows.length === 1 };
}

export async function listWardrobe(client: PoolClient, actorUserId: string) {
  const rows = await client.query<{ garment_id: string }>(
    `SELECT garment_id FROM wardrobe_items WHERE user_id = $1 ORDER BY created_at, garment_id`,
    [actorUserId],
  );
  const items: ItemView[] = [];
  for (const row of rows.rows) {
    const item = await readableItem(client, actorUserId, row.garment_id, "top");
    if (item.available) items.push(item);
  }
  return {
    items,
    meaning: "A wardrobe item is a catalog garment you added. It is not a purchase or a stock record.",
  };
}

export async function createStylingSession(
  client: PoolClient,
  actorUserId: string,
  input: {
    occasionSlug: string | null;
    styleSlug: string | null;
    anchorGarmentId: string | null;
    source: "catalog" | "wardrobe";
    useSavedPreferences: boolean;
  },
) {
  const occasion = input.occasionSlug ? await requireTerm(client, "occasion", input.occasionSlug) : null;
  const style = input.styleSlug ? await requireTerm(client, "style", input.styleSlug) : null;
  if (input.anchorGarmentId) await getCatalogGarment(client, actorUserId, input.anchorGarmentId);
  const preferences = input.useSavedPreferences ? await preferenceRows(client, actorUserId) : [];
  const pool = await readablePool(client, actorUserId);
  let garments = pool.garments;
  if (input.source === "wardrobe") {
    const wardrobe = await client.query<{ garment_id: string }>(
      `SELECT garment_id FROM wardrobe_items WHERE user_id = $1`,
      [actorUserId],
    );
    const ids = new Set(wardrobe.rows.map((row) => row.garment_id));
    garments = garments.filter((garment) => ids.has(garment.id));
  }
  if (input.anchorGarmentId && input.source === "wardrobe" && !garments.some((garment) => garment.id === input.anchorGarmentId)) {
    throw invalid("not_in_wardrobe", "The selected garment is not in your wardrobe.");
  }
  const result = recommendOutfits({
    garments,
    preferences: preferences.map((item) => ({ polarity: item.polarity, kind: item.kind, slug: item.slug })),
    occasion,
    style,
    anchorId: input.anchorGarmentId,
    poolLimited: pool.limited,
  });
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO styling_sessions (
       user_id, rule_set, status, summary, source, occasion_term_id, style_term_id, anchor_garment_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      actorUserId,
      styleRuleSetId,
      result.status,
      result.summary,
      input.source,
      occasion?.id ?? null,
      style?.id ?? null,
      input.anchorGarmentId,
    ],
  );
  const sessionId = inserted.rows[0]?.id;
  if (!sessionId) throw invalid("invalid_body", "The styling session could not be saved.");
  await insertNotes(client, "styling_session_notes", "session_id", sessionId, result.sessionNotes);
  for (let index = 0; index < result.recommendations.length; index += 1) {
    const recommendation = result.recommendations[index];
    if (!recommendation) continue;
    const saved = await client.query<{ id: string }>(
      `INSERT INTO styling_recommendations (session_id, position, rule_match_count)
       VALUES ($1, $2, $3) RETURNING id`,
      [sessionId, index, recommendation.ruleMatchCount],
    );
    const recommendationId = saved.rows[0]?.id;
    if (!recommendationId) throw invalid("invalid_body", "The recommendation could not be saved.");
    for (const item of recommendation.items) {
      await client.query(
        `INSERT INTO styling_recommendation_items (recommendation_id, garment_id, role) VALUES ($1, $2, $3)`,
        [recommendationId, item.garmentId, item.role],
      );
    }
    await insertNotes(client, "styling_recommendation_notes", "recommendation_id", recommendationId, recommendation.notes);
  }
  return loadSession(client, actorUserId, sessionId);
}

export async function listStylingSessions(client: PoolClient, actorUserId: string) {
  const rows = await client.query<{ id: string; status: string; summary: string; created_at: Date }>(
    `SELECT id, status, summary, created_at FROM styling_sessions
     WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20`,
    [actorUserId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function requireStylingSession(client: PoolClient, actorUserId: string, sessionId: string) {
  return loadSession(client, actorUserId, sessionId);
}

export async function rejectRecommendation(client: PoolClient, actorUserId: string, sessionId: string, recommendationId: string) {
  await loadSession(client, actorUserId, sessionId);
  const updated = await client.query(
    `UPDATE styling_recommendations SET rejected_at = now()
     WHERE id = $1 AND session_id = $2 AND rejected_at IS NULL`,
    [recommendationId, sessionId],
  );
  if (!updated.rowCount) throw notFound("That recommendation was not found.");
  return loadSession(client, actorUserId, sessionId);
}

export async function saveRecommendation(
  client: PoolClient,
  actorUserId: string,
  sessionId: string,
  recommendationId: string,
  name: string,
) {
  const session = await loadSession(client, actorUserId, sessionId);
  const recommendation = session.recommendations.find((item) => item.id === recommendationId);
  if (!recommendation) throw notFound("That recommendation was not found.");
  if (recommendation.items.some((item) => !item.available)) {
    throw invalid("unavailable_item", "A garment in that recommendation is no longer readable.");
  }
  const outfit = await createOutfit(client, actorUserId, {
    name,
    notes: "",
    items: recommendation.items.map((item) => ({ garmentId: item.garmentId, role: item.role })),
  });
  await client.query(`UPDATE styling_recommendations SET saved_outfit_id = $2 WHERE id = $1`, [recommendationId, outfit.id]);
  return outfit;
}

export async function createOutfit(
  client: PoolClient,
  actorUserId: string,
  input: { name: string; notes: string; items: { garmentId: string; role: string }[] },
) {
  const name = cleanName(input.name);
  const notes = cleanNotes(input.notes);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO outfits (owner_user_id, name, notes) VALUES ($1, $2, $3) RETURNING id`,
    [actorUserId, name, notes],
  );
  const outfitId = inserted.rows[0]?.id;
  if (!outfitId) throw invalid("invalid_name", "Outfit name is required.");
  for (const item of input.items) {
    await insertOutfitItem(client, actorUserId, outfitId, item.garmentId, item.role);
  }
  return loadOutfit(client, actorUserId, outfitId);
}

export async function updateOutfit(
  client: PoolClient,
  actorUserId: string,
  outfitId: string,
  input: { name?: string; notes?: string },
) {
  await lockOutfit(client, actorUserId, outfitId);
  if (input.name !== undefined) {
    await client.query(`UPDATE outfits SET name = $2, updated_at = now() WHERE id = $1`, [outfitId, cleanName(input.name)]);
  }
  if (input.notes !== undefined) {
    await client.query(`UPDATE outfits SET notes = $2, updated_at = now() WHERE id = $1`, [outfitId, cleanNotes(input.notes)]);
  }
  return loadOutfit(client, actorUserId, outfitId);
}

export async function listOutfits(client: PoolClient, actorUserId: string) {
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM outfits WHERE owner_user_id = $1 ORDER BY updated_at DESC, id DESC`,
    [actorUserId],
  );
  const outfits = [];
  for (const row of rows.rows) outfits.push(await loadOutfit(client, actorUserId, row.id));
  return outfits;
}

export async function requireOutfit(client: PoolClient, actorUserId: string, outfitId: string) {
  return loadOutfit(client, actorUserId, outfitId);
}

export async function setOutfitItem(
  client: PoolClient,
  actorUserId: string,
  outfitId: string,
  garmentId: string,
  role: string,
) {
  await lockOutfit(client, actorUserId, outfitId);
  const outfitRole = await assertRole(client, actorUserId, garmentId, role);
  const duplicate = await client.query(
    `SELECT role FROM outfit_items WHERE outfit_id = $1 AND garment_id = $2 AND role <> $3`,
    [outfitId, garmentId, outfitRole],
  );
  if (duplicate.rows.length > 0) throw invalid("conflict", "That garment is already in this outfit.");
  await client.query(`DELETE FROM outfit_items WHERE outfit_id = $1 AND role = $2`, [outfitId, outfitRole]);
  await client.query(`INSERT INTO outfit_items (outfit_id, garment_id, role) VALUES ($1, $2, $3)`, [
    outfitId,
    garmentId,
    outfitRole,
  ]);
  await client.query(`UPDATE outfits SET updated_at = now() WHERE id = $1`, [outfitId]);
  return loadOutfit(client, actorUserId, outfitId);
}

export async function removeOutfitItem(client: PoolClient, actorUserId: string, outfitId: string, role: string) {
  await lockOutfit(client, actorUserId, outfitId);
  if (!roles.has(role as OutfitRole)) throw invalid("invalid_role", "That outfit place is not supported.");
  const removed = await client.query(`DELETE FROM outfit_items WHERE outfit_id = $1 AND role = $2`, [outfitId, role]);
  if (!removed.rowCount) throw notFound("That outfit item was not found.");
  await client.query(`UPDATE outfits SET updated_at = now() WHERE id = $1`, [outfitId]);
  return loadOutfit(client, actorUserId, outfitId);
}

export async function listAlternatives(client: PoolClient, actorUserId: string, outfitId: string, role: string) {
  if (!roles.has(role as OutfitRole)) throw invalid("invalid_role", "That outfit place is not supported.");
  const outfit = await loadOutfit(client, actorUserId, outfitId);
  const preferences = await preferenceRows(client, actorUserId);
  const pool = await readablePool(client, actorUserId);
  const used = new Set(outfit.items.map((item) => item.garmentId));
  const others = pool.garments.filter((garment) => used.has(garment.id) && garment.id !== outfit.items.find((item) => item.role === role)?.garmentId);
  const alternatives = [];
  for (const garment of pool.garments) {
    if (outfitRoleForType(garment.typeSlug) !== role) continue;
    if (used.has(garment.id)) continue;
    const notes = explainAlternative(
      garment,
      role as OutfitRole,
      others,
      preferences.map((item) => ({ polarity: item.polarity, kind: item.kind, slug: item.slug })),
    );
    alternatives.push({
      garmentId: garment.id,
      name: garment.name,
      typeSlug: garment.typeSlug,
      terms: garment.terms,
      ruleMatchCount: notes.filter((note) => note.kind === "match").length,
      notes,
    });
  }
  alternatives.sort((left, right) => right.ruleMatchCount - left.ruleMatchCount || left.name.localeCompare(right.name));
  return alternatives.slice(0, 12);
}

async function readablePool(client: PoolClient, actorUserId: string) {
  const ids = await client.query<{ id: string }>(
    `SELECT garment.id
     FROM garments AS garment
     WHERE garment.visibility = 'public'
        OR garment.owner_user_id = $1::uuid
        OR EXISTS (
          SELECT 1 FROM organization_memberships AS membership
          WHERE membership.organization_id = garment.owner_organization_id
            AND membership.user_id = $1::uuid
            AND membership.status = 'active'
        )
     ORDER BY garment.name, garment.id
     LIMIT 81`,
    [actorUserId],
  );
  const limited = ids.rows.length > 80;
  const chosen = ids.rows.slice(0, 80).map((row) => row.id);
  if (chosen.length === 0) return { garments: [] as StyleGarment[], limited };
  const rows = await client.query<{ id: string; name: string; type_slug: string | null }>(
    `SELECT garment.id, garment.name, type_term.slug AS type_slug
     FROM garments AS garment
     LEFT JOIN fashion_terms AS type_term ON type_term.id = garment.garment_type_id
     WHERE garment.id = ANY($1::uuid[])`,
    [chosen],
  );
  const terms = await client.query<StyleTerm & { garment_id: string }>(
    `SELECT garment_terms.garment_id, fashion_terms.kind, fashion_terms.slug, fashion_terms.name
     FROM garment_terms
     JOIN fashion_terms ON fashion_terms.id = garment_terms.term_id
     WHERE garment_terms.garment_id = ANY($1::uuid[])`,
    [chosen],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const garments = chosen.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        name: row.name,
        typeSlug: row.type_slug,
        terms: terms.rows
          .filter((term) => term.garment_id === id)
          .map(({ kind, slug, name }) => ({ kind, slug, name })),
      },
    ];
  });
  return { garments, limited };
}

async function loadSession(client: PoolClient, actorUserId: string, sessionId: string) {
  const found = await client.query<{
    id: string;
    status: "completed" | "insufficient_data";
    summary: string;
    source: string;
    created_at: Date;
  }>(
    `SELECT id, status, summary, source, created_at FROM styling_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, actorUserId],
  );
  const session = found.rows[0];
  if (!session) throw notFound("Styling session was not found.");
  const sessionNotes = await client.query<StyleNote>(
    `SELECT kind, message FROM styling_session_notes WHERE session_id = $1 ORDER BY position`,
    [sessionId],
  );
  const recommendations = await client.query<{
    id: string;
    rule_match_count: number;
    saved_outfit_id: string | null;
    rejected_at: Date | null;
  }>(
    `SELECT id, rule_match_count, saved_outfit_id, rejected_at
     FROM styling_recommendations WHERE session_id = $1 ORDER BY position`,
    [sessionId],
  );
  const views = [];
  for (const recommendation of recommendations.rows) {
    const items = await client.query<{ garment_id: string; role: OutfitRole }>(
      `SELECT garment_id, role FROM styling_recommendation_items WHERE recommendation_id = $1 ORDER BY role`,
      [recommendation.id],
    );
    const notes = await client.query<StyleNote>(
      `SELECT kind, message FROM styling_recommendation_notes WHERE recommendation_id = $1 ORDER BY position`,
      [recommendation.id],
    );
    const itemViews: ItemView[] = [];
    for (const item of items.rows) itemViews.push(await readableItem(client, actorUserId, item.garment_id, item.role));
    views.push({
      id: recommendation.id,
      ruleMatchCount: recommendation.rule_match_count,
      savedOutfitId: recommendation.saved_outfit_id,
      rejected: recommendation.rejected_at !== null,
      items: itemViews,
      notes: notes.rows,
      rankingMeaning: "ruleMatchCount counts documented match notes. It is not a fashion-quality score.",
    });
  }
  return {
    id: session.id,
    status: session.status,
    summary: session.summary,
    source: session.source,
    ruleSet: styleRuleSetId,
    fashionQualityScore: false,
    notes: sessionNotes.rows,
    recommendations: views,
    createdAt: session.created_at.toISOString(),
  };
}

async function loadOutfit(client: PoolClient, actorUserId: string, outfitId: string) {
  const found = await client.query<{ id: string; name: string; notes: string; updated_at: Date }>(
    `SELECT id, name, notes, updated_at FROM outfits WHERE id = $1 AND owner_user_id = $2`,
    [outfitId, actorUserId],
  );
  const outfit = found.rows[0];
  if (!outfit) throw notFound("Outfit was not found.");
  const items = await client.query<{ garment_id: string; role: OutfitRole }>(
    `SELECT garment_id, role FROM outfit_items WHERE outfit_id = $1 ORDER BY role`,
    [outfitId],
  );
  const views: ItemView[] = [];
  for (const item of items.rows) views.push(await readableItem(client, actorUserId, item.garment_id, item.role));
  return {
    id: outfit.id,
    name: outfit.name,
    notes: outfit.notes,
    items: views,
    preview: "catalog_board",
    updatedAt: outfit.updated_at.toISOString(),
  };
}

async function readableItem(client: PoolClient, actorUserId: string, garmentId: string, role: OutfitRole): Promise<ItemView> {
  try {
    const garment = await getCatalogGarment(client, actorUserId, garmentId);
    return {
      garmentId,
      role,
      available: true,
      name: garment.name,
      typeSlug: garment.garmentType?.slug ?? null,
      terms: garment.terms,
      mediaId: garment.media[0]?.id ?? null,
    };
  } catch (error) {
    if (error instanceof DomainError && error.code === "not_found") {
      return { garmentId, role, available: false, name: null, typeSlug: null, terms: [], mediaId: null };
    }
    throw error;
  }
}

async function insertOutfitItem(client: PoolClient, actorUserId: string, outfitId: string, garmentId: string, role: string) {
  const outfitRole = await assertRole(client, actorUserId, garmentId, role);
  try {
    await client.query(`INSERT INTO outfit_items (outfit_id, garment_id, role) VALUES ($1, $2, $3)`, [
      outfitId,
      garmentId,
      outfitRole,
    ]);
  } catch (error) {
    if (isUnique(error)) throw invalid("conflict", "That garment or place is already in this outfit.");
    throw error;
  }
}

async function assertRole(client: PoolClient, actorUserId: string, garmentId: string, role: string): Promise<OutfitRole> {
  if (!roles.has(role as OutfitRole)) throw invalid("invalid_role", "That outfit place is not supported.");
  const garment = await getCatalogGarment(client, actorUserId, garmentId);
  const expected = outfitRoleForType(garment.garmentType?.slug ?? null);
  if (expected !== role) throw invalid("role_mismatch", "That garment type does not fill this outfit place.");
  return role as OutfitRole;
}

async function lockOutfit(client: PoolClient, actorUserId: string, outfitId: string) {
  const found = await client.query(`SELECT id FROM outfits WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [
    outfitId,
    actorUserId,
  ]);
  if (!found.rows[0]) throw notFound("Outfit was not found.");
}

async function preferenceRows(client: PoolClient, actorUserId: string): Promise<PreferenceView[]> {
  const rows = await client.query<PreferenceView>(
    `SELECT preference.polarity, term.kind, term.slug, term.name
     FROM styling_preferences AS preference
     JOIN fashion_terms AS term ON term.id = preference.term_id
     WHERE preference.user_id = $1
     ORDER BY preference.polarity, term.kind, term.slug`,
    [actorUserId],
  );
  return rows.rows;
}

async function requireTerm(client: PoolClient, kind: string, slug: string): Promise<StyleTerm & { id: string }> {
  const found = await client.query<StyleTerm & { id: string }>(
    `SELECT id, kind, slug, name FROM fashion_terms WHERE kind = $1 AND slug = $2`,
    [kind, slug],
  );
  const term = found.rows[0];
  if (!term) throw invalid("unknown_term", "That styling term was not found.");
  return term;
}

async function insertNotes(
  client: PoolClient,
  table: "styling_session_notes" | "styling_recommendation_notes",
  column: "session_id" | "recommendation_id",
  id: string,
  notes: StyleNote[],
) {
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (!note) continue;
    await client.query(`INSERT INTO ${table} (${column}, position, kind, message) VALUES ($1, $2, $3, $4)`, [
      id,
      index,
      note.kind,
      note.message,
    ]);
  }
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) throw invalid("invalid_name", "Outfit name is required.");
  return name;
}

function cleanNotes(value: string): string {
  const notes = value.trim();
  if (notes.length > 500) throw invalid("invalid_notes", "Notes are too long.");
  return notes;
}

function isUnique(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
