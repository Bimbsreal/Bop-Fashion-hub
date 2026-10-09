import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, optionalString, requireUuid, requiredString } from "../http/body";
import {
  addWardrobeItem,
  clearStylingPreferences,
  createOutfit,
  createStylingSession,
  getStylingProfile,
  listAlternatives,
  listOutfits,
  listStyleVocabulary,
  listStylingSessions,
  listWardrobe,
  rejectRecommendation,
  removeOutfitItem,
  removeWardrobeItem,
  replaceStylingProfile,
  requireOutfit,
  requireStylingSession,
  saveRecommendation,
  setOutfitItem,
  styleRuleDescription,
  updateOutfit,
} from "../modules/styling";

const blockedFields = ["budget", "price", "silhouette", "ethnicity", "religion", "url", "confidence", "image", "organizationId", "fitScore"];

export function styleRouter() {
  const router = Router();

  router.get("/rules", (_request, response) => {
    requireUser(response);
    response.json({ rules: styleRuleDescription() });
  });

  router.get("/vocabulary", async (_request, response) => {
    requireUser(response);
    const vocabulary = await withTransaction((client) => listStyleVocabulary(client));
    response.json({ vocabulary });
  });

  router.get("/profile", async (_request, response) => {
    const actorUserId = requireUser(response);
    const profile = await withTransaction((client) => getStylingProfile(client, actorUserId));
    response.json({ profile });
  });

  router.put("/profile", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const profile = await withTransaction((client) =>
      replaceStylingProfile(client, actorUserId, {
        notes: optionalString(body.notes) ?? "",
        preferences: preferenceList(body.preferences),
      }),
    );
    response.json({ profile });
  });

  router.delete("/profile", async (_request, response) => {
    const actorUserId = requireUser(response);
    const profile = await withTransaction((client) => clearStylingPreferences(client, actorUserId));
    response.json({ profile });
  });

  router.get("/wardrobe", async (_request, response) => {
    const actorUserId = requireUser(response);
    const wardrobe = await withTransaction((client) => listWardrobe(client, actorUserId));
    response.json({ wardrobe });
  });

  router.post("/wardrobe", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const item = await withTransaction((client) =>
      addWardrobeItem(client, actorUserId, requireUuid(requiredString(body.garmentId, "not_found", "Garment was not found."))),
    );
    response.status(201).json({ item });
  });

  router.delete("/wardrobe/:garmentId", async (request, response) => {
    const actorUserId = requireUser(response);
    const item = await withTransaction((client) => removeWardrobeItem(client, actorUserId, pathId(request.params.garmentId)));
    response.json({ item });
  });

  router.post("/sessions", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const session = await withTransaction((client) =>
      createStylingSession(client, actorUserId, {
        occasionSlug: optionalSlug(body.occasion),
        styleSlug: optionalSlug(body.style),
        anchorGarmentId: optionalId(body.anchorGarmentId),
        source: sourceOf(body.source),
        useSavedPreferences: body.useSavedPreferences === undefined ? true : boolOf(body.useSavedPreferences),
      }),
    );
    response.status(201).json({ session });
  });

  router.get("/sessions", async (_request, response) => {
    const actorUserId = requireUser(response);
    const sessions = await withTransaction((client) => listStylingSessions(client, actorUserId));
    response.json({ sessions });
  });

  router.get("/sessions/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const session = await withTransaction((client) => requireStylingSession(client, actorUserId, pathId(request.params.id)));
    response.json({ session });
  });

  router.post("/sessions/:id/recommendations/:recommendationId/reject", async (request, response) => {
    const actorUserId = requireUser(response);
    const session = await withTransaction((client) =>
      rejectRecommendation(client, actorUserId, pathId(request.params.id), pathId(request.params.recommendationId)),
    );
    response.json({ session });
  });

  router.post("/sessions/:id/recommendations/:recommendationId/save", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const outfit = await withTransaction((client) =>
      saveRecommendation(
        client,
        actorUserId,
        pathId(request.params.id),
        pathId(request.params.recommendationId),
        requiredString(body.name, "invalid_name", "Outfit name is required."),
      ),
    );
    response.status(201).json({ outfit });
  });

  router.get("/outfits", async (_request, response) => {
    const actorUserId = requireUser(response);
    const outfits = await withTransaction((client) => listOutfits(client, actorUserId));
    response.json({ outfits });
  });

  router.post("/outfits", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const outfit = await withTransaction((client) =>
      createOutfit(client, actorUserId, {
        name: requiredString(body.name, "invalid_name", "Outfit name is required."),
        notes: optionalString(body.notes) ?? "",
        items: itemList(body.items),
      }),
    );
    response.status(201).json({ outfit });
  });

  router.get("/outfits/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const outfit = await withTransaction((client) => requireOutfit(client, actorUserId, pathId(request.params.id)));
    response.json({ outfit });
  });

  router.patch("/outfits/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const outfit = await withTransaction((client) =>
      updateOutfit(client, actorUserId, pathId(request.params.id), {
        name: optionalString(body.name),
        notes: optionalString(body.notes),
      }),
    );
    response.json({ outfit });
  });

  router.put("/outfits/:id/items", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const outfit = await withTransaction((client) =>
      setOutfitItem(
        client,
        actorUserId,
        pathId(request.params.id),
        requireUuid(requiredString(body.garmentId, "not_found", "Garment was not found.")),
        requiredString(body.role, "invalid_role", "Choose an outfit place."),
      ),
    );
    response.json({ outfit });
  });

  router.delete("/outfits/:id/items/:role", async (request, response) => {
    const actorUserId = requireUser(response);
    const role = request.params.role;
    if (typeof role !== "string") throw invalid("invalid_role", "Choose an outfit place.");
    const outfit = await withTransaction((client) => removeOutfitItem(client, actorUserId, pathId(request.params.id), role));
    response.json({ outfit });
  });

  router.get("/outfits/:id/alternatives", async (request, response) => {
    const actorUserId = requireUser(response);
    const role = request.query.role;
    if (typeof role !== "string") throw invalid("invalid_role", "Choose an outfit place.");
    const alternatives = await withTransaction((client) =>
      listAlternatives(client, actorUserId, pathId(request.params.id), role),
    );
    response.json({ alternatives });
  });

  return router;
}

function preferenceList(value: unknown): { polarity: string; kind: string; slug: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("invalid_preference", "Preferences must be a list.");
  return value.map((item) => {
    const record = objectBody(item);
    return {
      polarity: requiredString(record.polarity, "invalid_preference", "A preference needs a polarity."),
      kind: requiredString(record.kind, "invalid_preference", "A preference needs a kind."),
      slug: requiredString(record.slug, "unknown_term", "A preference needs a term.").trim().toLowerCase(),
    };
  });
}

function itemList(value: unknown): { garmentId: string; role: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("invalid_body", "Outfit items must be a list.");
  return value.map((item) => {
    const record = objectBody(item);
    return {
      garmentId: requireUuid(requiredString(record.garmentId, "not_found", "Garment was not found.")),
      role: requiredString(record.role, "invalid_role", "Choose an outfit place."),
    };
  });
}

function optionalSlug(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw invalid("unknown_term", "That styling term was not found.");
  }
  return value;
}

function optionalId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalid("not_found", "Garment was not found.");
  return requireUuid(value);
}

function sourceOf(value: unknown): "catalog" | "wardrobe" {
  if (value === undefined || value === "catalog") return "catalog";
  if (value === "wardrobe") return "wardrobe";
  throw invalid("invalid_source", "Choose catalog or wardrobe.");
}

function boolOf(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid("invalid_body", "Expected true or false.");
  return value;
}

function rejectBlocked(body: Record<string, unknown>) {
  for (const key of blockedFields) {
    if (key in body) throw invalid("unsupported_constraint", "That field is not accepted.");
  }
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}
