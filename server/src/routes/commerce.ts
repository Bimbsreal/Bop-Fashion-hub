import { Router } from "express";
import { withTransaction } from "../db/pool";
import { invalid } from "../errors";
import { requireUser } from "../http/actor";
import { objectBody, optionalSlug, optionalString, pageLimit, pageOffset, requireUuid, requiredString } from "../http/body";
import {
  attachListingMedia,
  changeListingStatus,
  createBusiness,
  createListing,
  discoverListings,
  listBusinessListings,
  listMyBusinesses,
  requireBusiness,
  requireListing,
  updateBusiness,
  updateListing,
  type ListingInput,
} from "../modules/commerce";

const blocked = ["verified", "payment", "checkout", "order", "url"];

export function commerceRouter() {
  const router = Router();

  router.get("/businesses", async (_request, response) => {
    const actorUserId = requireUser(response);
    const businesses = await withTransaction((client) => listMyBusinesses(client, actorUserId));
    response.json({ businesses });
  });

  router.post("/businesses", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const business = await withTransaction((client) =>
      createBusiness(client, actorUserId, {
        name: requiredString(body.name, "invalid_name", "Business name is required."),
        slug: requiredString(body.slug, "invalid_slug", "Use a lowercase slug."),
        kind: requiredString(body.kind, "invalid_kind", "Choose studio, tailor, brand, or retailer."),
      }),
    );
    response.status(201).json({ business });
  });

  router.get("/businesses/:id", async (request, response) => {
    const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
    const business = await withTransaction((client) => requireBusiness(client, actorUserId, pathId(request.params.id)));
    response.json({ business });
  });

  router.patch("/businesses/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const business = await withTransaction((client) =>
      updateBusiness(client, actorUserId, pathId(request.params.id), {
        description: optionalString(body.description),
        inquiryNote: optionalString(body.inquiryNote),
        specialties: stringList(body.specialties),
        logoMediaId: optionalMedia(body.logoMediaId),
        publication: optionalString(body.publication),
      }),
    );
    response.json({ business });
  });

  router.get("/businesses/:id/listings", async (request, response) => {
    const actorUserId = requireUser(response);
    const listings = await withTransaction((client) => listBusinessListings(client, actorUserId, pathId(request.params.id)));
    response.json({ listings });
  });

  router.post("/businesses/:id/listings", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    const listing = await withTransaction((client) =>
      createListing(client, actorUserId, pathId(request.params.id), listingInput(body)),
    );
    response.status(201).json({ listing });
  });

  router.get("/listings", async (request, response) => {
    const page = await withTransaction((client) =>
      discoverListings(client, {
        limit: pageLimit(request.query.limit),
        offset: pageOffset(request.query.offset),
        offering: optionalToken(request.query.offering),
        type: optionalSlug(request.query.type),
        style: optionalSlug(request.query.style),
        material: optionalSlug(request.query.material),
        organization: optionalSlug(request.query.organization),
        currency: optionalCurrency(request.query.currency),
        availability: optionalSlug(request.query.availability),
        minMinor: optionalMinor(request.query.minMinor),
        maxMinor: optionalMinor(request.query.maxMinor),
      }),
    );
    response.json({
      listings: page.listings,
      page: { limit: pageLimit(request.query.limit), offset: pageOffset(request.query.offset), total: page.total },
    });
  });

  router.get("/listings/:id", async (request, response) => {
    const actorUserId = typeof response.locals.userId === "string" ? response.locals.userId : null;
    const listing = await withTransaction((client) => requireListing(client, actorUserId, pathId(request.params.id)));
    response.json({ listing });
  });

  router.patch("/listings/:id", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    rejectBlocked(body);
    if ("status" in body) throw invalid("invalid_transition", "Use the status action to change publication.");
    const listing = await withTransaction((client) => updateListing(client, actorUserId, pathId(request.params.id), listingInput(body)));
    response.json({ listing });
  });

  router.post("/listings/:id/status", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    const listing = await withTransaction((client) =>
      changeListingStatus(
        client,
        actorUserId,
        pathId(request.params.id),
        requiredString(body.status, "invalid_transition", "Choose a listing status."),
      ),
    );
    response.json({ listing });
  });

  router.post("/listings/:id/media", async (request, response) => {
    const actorUserId = requireUser(response);
    const body = objectBody(request.body);
    const listing = await withTransaction((client) =>
      attachListingMedia(
        client,
        actorUserId,
        pathId(request.params.id),
        requireUuid(requiredString(body.mediaId, "not_found", "Media was not found.")),
      ),
    );
    response.json({ listing });
  });

  return router;
}

function listingInput(body: Record<string, unknown>): ListingInput {
  return {
    offering: requiredString(body.offering, "invalid_offering", "Choose a supported offering."),
    title: requiredString(body.title, "invalid_title", "Listing title is required."),
    description: optionalString(body.description) ?? "",
    garmentId: optionalId(body.garmentId),
    size: sizeOf(body.size),
    designRevisionId: optionalId(body.designRevisionId),
    pricingMethod: requiredString(body.pricingMethod, "invalid_price", "Choose a pricing method."),
    currency: optionalCurrency(body.currency),
    amountMinor: optionalMinor(body.amountMinor),
    amountMaxMinor: optionalMinor(body.amountMaxMinor),
    availability: optionalString(body.availability) ?? "unspecified",
    customizationNote: optionalString(body.customizationNote) ?? "",
    turnaroundNote: optionalString(body.turnaroundNote) ?? "",
  };
}

function optionalId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}

function optionalToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value)) {
    throw invalid("invalid_filter", "Filter is not valid.");
  }
  return value;
}

function optionalCurrency(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw invalid("invalid_currency", "Use a three-letter currency code.");
  return value;
}

function optionalMinor(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value === "number") return value;
  throw invalid("invalid_price", "Enter a non-negative whole amount in minor currency units.");
}

function sizeOf(value: unknown): { system: string; label: string } | null {
  if (value === undefined || value === null) return null;
  const record = objectBody(value);
  return {
    system: requiredString(record.system, "unknown_size", "Size label was not found.").trim().toLowerCase(),
    label: requiredString(record.label, "unknown_size", "Size label was not found.").trim(),
  };
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid("invalid_kind", "Specialties must be a list.");
  }
  return value as string[];
}

function optionalMedia(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid("not_found", "Media was not found.");
  return requireUuid(value);
}

function rejectBlocked(body: Record<string, unknown>) {
  for (const key of blocked) {
    if (key in body) throw invalid("unsupported_constraint", "That field is not accepted.");
  }
}

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalid("not_found", "Not found.");
  return requireUuid(value);
}
