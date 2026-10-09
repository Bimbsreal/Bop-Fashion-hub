import type { PoolClient } from "pg";
import { activeMembership } from "./access";
import { forbidden, invalid, notFound } from "../errors";
import { getCatalogGarment } from "./fashion";
import { createOrganization, type OrganizationKind } from "./organizations";

const kinds = new Set<OrganizationKind>(["studio", "tailor", "brand", "retailer"]);
const offerings = new Set(["ready_to_wear", "made_to_order", "custom_service", "design_commission"]);
const methods = new Set(["fixed", "starting", "range", "quote"]);
const availabilityValues = new Set(["available", "unavailable", "unspecified"]);
const transitions: Record<string, string[]> = {
  draft: ["published", "archived"],
  published: ["paused", "archived"],
  paused: ["published", "archived"],
  archived: [],
};

type ListingStatus = "draft" | "published" | "paused" | "archived";
type PricingMethod = "fixed" | "starting" | "range" | "quote";

export type ListingInput = {
  offering: string;
  title: string;
  description: string;
  garmentId: string | null;
  size: { system: string; label: string } | null;
  designRevisionId: string | null;
  pricingMethod: string;
  currency: string | null;
  amountMinor: number | null;
  amountMaxMinor: number | null;
  availability: string;
  customizationNote: string;
  turnaroundNote: string;
};

export async function createBusiness(
  client: PoolClient,
  actorUserId: string,
  input: { name: string; slug: string; kind: string },
) {
  if (!kinds.has(input.kind as OrganizationKind)) throw invalid("invalid_kind", "Choose studio, tailor, brand, or retailer.");
  let organization;
  try {
    organization = await createOrganization(client, actorUserId, {
      name: input.name,
      slug: input.slug,
      kind: input.kind as OrganizationKind,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw invalid("conflict", "That business slug is already in use.");
    }
    throw error;
  }
  await client.query(
    `INSERT INTO organization_profiles (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`,
    [organization.id],
  );
  await client.query(
    `INSERT INTO organization_specialties (organization_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [organization.id, organization.kind],
  );
  return loadBusiness(client, actorUserId, organization.id);
}

export async function updateBusiness(
  client: PoolClient,
  actorUserId: string,
  organizationId: string,
  input: {
    description?: string;
    inquiryNote?: string;
    specialties?: string[];
    logoMediaId?: string | null;
    publication?: string;
  },
) {
  await assertPublisher(client, actorUserId, organizationId);
  await ensureProfile(client, organizationId);
  if (input.description !== undefined) {
    const description = input.description.trim();
    if (description.length > 2000) throw invalid("invalid_description", "Description is too long.");
    await client.query(`UPDATE organization_profiles SET description = $2, updated_at = now() WHERE organization_id = $1`, [
      organizationId,
      description,
    ]);
  }
  if (input.inquiryNote !== undefined) {
    const note = input.inquiryNote.trim();
    if (note.length > 500) throw invalid("invalid_inquiry", "Inquiry note is too long.");
    await client.query(`UPDATE organization_profiles SET inquiry_note = $2, updated_at = now() WHERE organization_id = $1`, [
      organizationId,
      note,
    ]);
  }
  if (input.specialties) {
    if (input.specialties.length === 0 || input.specialties.length > 4) {
      throw invalid("invalid_kind", "Choose at least one business specialty.");
    }
    const unique = [...new Set(input.specialties)];
    for (const kind of unique) {
      if (!kinds.has(kind as OrganizationKind)) throw invalid("invalid_kind", "Choose studio, tailor, brand, or retailer.");
    }
    await client.query(`DELETE FROM organization_specialties WHERE organization_id = $1`, [organizationId]);
    for (const kind of unique) {
      await client.query(`INSERT INTO organization_specialties (organization_id, kind) VALUES ($1, $2)`, [organizationId, kind]);
    }
    await client.query(`UPDATE organization_profiles SET updated_at = now() WHERE organization_id = $1`, [organizationId]);
  }
  if (input.logoMediaId !== undefined) {
    if (input.logoMediaId === null) {
      await client.query(`UPDATE organization_profiles SET logo_media_id = NULL, updated_at = now() WHERE organization_id = $1`, [
        organizationId,
      ]);
    } else {
      await assertOrganizationMedia(client, organizationId, input.logoMediaId);
      await client.query(`UPDATE organization_profiles SET logo_media_id = $2, updated_at = now() WHERE organization_id = $1`, [
        organizationId,
        input.logoMediaId,
      ]);
    }
  }
  if (input.publication !== undefined) {
    if (input.publication !== "draft" && input.publication !== "published") {
      throw invalid("invalid_transition", "A business profile is draft or published.");
    }
    await client.query(`UPDATE organization_profiles SET publication = $2, updated_at = now() WHERE organization_id = $1`, [
      organizationId,
      input.publication,
    ]);
  }
  return loadBusiness(client, actorUserId, organizationId);
}

export async function requireBusiness(client: PoolClient, actorUserId: string | null, organizationId: string) {
  return loadBusiness(client, actorUserId, organizationId);
}

export async function listMyBusinesses(client: PoolClient, actorUserId: string) {
  const rows = await client.query<{ organization_id: string }>(
    `SELECT organization_id FROM organization_memberships
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at, organization_id`,
    [actorUserId],
  );
  const businesses = [];
  for (const row of rows.rows) businesses.push(await loadBusiness(client, actorUserId, row.organization_id));
  return businesses;
}

export async function createListing(client: PoolClient, actorUserId: string, organizationId: string, input: ListingInput) {
  await assertMember(client, actorUserId, organizationId);
  const fields = await normalizeListing(client, actorUserId, organizationId, input);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO commercial_listings (
       organization_id, created_by_user_id, offering, title, description, garment_id, size_label_id,
       design_revision_id, pricing_method, currency, amount_minor, amount_max_minor, availability,
       customization_note, turnaround_note
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      organizationId,
      actorUserId,
      fields.offering,
      fields.title,
      fields.description,
      fields.garmentId,
      fields.sizeLabelId,
      fields.designRevisionId,
      fields.pricingMethod,
      fields.currency,
      fields.amountMinor,
      fields.amountMaxMinor,
      fields.availability,
      fields.customizationNote,
      fields.turnaroundNote,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_title", "Listing title is required.");
  await client.query(
    `INSERT INTO commercial_listing_events (listing_id, actor_user_id, from_status, to_status) VALUES ($1, $2, NULL, 'draft')`,
    [id, actorUserId],
  );
  return loadListing(client, actorUserId, id);
}

export async function updateListing(client: PoolClient, actorUserId: string, listingId: string, input: ListingInput) {
  const current = await lockListing(client, listingId);
  await assertMember(client, actorUserId, current.organization_id);
  if (current.status === "archived") throw invalid("invalid_transition", "An archived listing cannot be edited.");
  const fields = await normalizeListing(client, actorUserId, current.organization_id, input);
  await client.query(
    `UPDATE commercial_listings SET
       offering = $2, title = $3, description = $4, garment_id = $5, size_label_id = $6,
       design_revision_id = $7, pricing_method = $8, currency = $9, amount_minor = $10,
       amount_max_minor = $11, availability = $12, customization_note = $13, turnaround_note = $14,
       updated_at = now()
     WHERE id = $1`,
    [
      listingId,
      fields.offering,
      fields.title,
      fields.description,
      fields.garmentId,
      fields.sizeLabelId,
      fields.designRevisionId,
      fields.pricingMethod,
      fields.currency,
      fields.amountMinor,
      fields.amountMaxMinor,
      fields.availability,
      fields.customizationNote,
      fields.turnaroundNote,
    ],
  );
  return loadListing(client, actorUserId, listingId);
}

export async function changeListingStatus(client: PoolClient, actorUserId: string, listingId: string, next: string) {
  const current = await lockListing(client, listingId);
  await assertPublisher(client, actorUserId, current.organization_id);
  const allowed = transitions[current.status] ?? [];
  if (!allowed.includes(next)) throw invalid("invalid_transition", "That listing status change is not available.");
  await client.query(
    `UPDATE commercial_listings
     SET status = $2, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END, updated_at = now()
     WHERE id = $1`,
    [listingId, next],
  );
  await client.query(
    `INSERT INTO commercial_listing_events (listing_id, actor_user_id, from_status, to_status) VALUES ($1, $2, $3, $4)`,
    [listingId, actorUserId, current.status, next],
  );
  return loadListing(client, actorUserId, listingId);
}

export async function attachListingMedia(client: PoolClient, actorUserId: string, listingId: string, mediaId: string) {
  const current = await lockListing(client, listingId);
  await assertMember(client, actorUserId, current.organization_id);
  if (current.status === "archived") throw invalid("invalid_transition", "An archived listing cannot be edited.");
  await assertOrganizationMedia(client, current.organization_id, mediaId);
  await client.query(
    `INSERT INTO commercial_listing_media (listing_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [listingId, mediaId],
  );
  return loadListing(client, actorUserId, listingId);
}

export async function listBusinessListings(client: PoolClient, actorUserId: string, organizationId: string) {
  await assertMember(client, actorUserId, organizationId);
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM commercial_listings WHERE organization_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 50`,
    [organizationId],
  );
  const listings = [];
  for (const row of rows.rows) listings.push(await loadListing(client, actorUserId, row.id));
  return listings;
}

export async function requireListing(client: PoolClient, actorUserId: string | null, listingId: string) {
  return loadListing(client, actorUserId, listingId);
}

export async function discoverListings(
  client: PoolClient,
  query: {
    limit: number;
    offset: number;
    offering?: string;
    type?: string;
    style?: string;
    material?: string;
    organization?: string;
    currency?: string | null;
    availability?: string | null;
    minMinor?: number | null;
    maxMinor?: number | null;
  },
) {
  const params: unknown[] = [];
  const where = [`listing.status = 'published'`, `organization.status = 'active'`];
  if (query.offering) {
    if (!offerings.has(query.offering)) throw invalid("invalid_filter", "That offering is not supported.");
    params.push(query.offering);
    where.push(`listing.offering = $${params.length}`);
  }
  if (query.currency) {
    if (!/^[A-Z]{3}$/.test(query.currency)) throw invalid("invalid_currency", "Use a three-letter currency code.");
    params.push(query.currency);
    where.push(`listing.currency = $${params.length}`);
  }
  if (query.availability) {
    if (!availabilityValues.has(query.availability)) throw invalid("invalid_filter", "That availability is not supported.");
    params.push(query.availability);
    where.push(`listing.availability = $${params.length}`);
  }
  if (query.organization) {
    params.push(query.organization);
    where.push(`organization.slug = $${params.length}`);
  }
  if (query.type) where.push(termExists(params, "garment_type", query.type));
  if (query.style) where.push(termExists(params, "style", query.style));
  if (query.material) where.push(termExists(params, "material", query.material));
  if (query.minMinor != null || query.maxMinor != null) {
    where.push(`listing.pricing_method IN ('fixed', 'starting', 'range')`);
    if (query.minMinor != null) {
      params.push(query.minMinor);
      where.push(`COALESCE(listing.amount_max_minor, listing.amount_minor) >= $${params.length}`);
    }
    if (query.maxMinor != null) {
      params.push(query.maxMinor);
      where.push(`listing.amount_minor <= $${params.length}`);
    }
  }
  const whereSql = where.join(" AND ");
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total
     FROM commercial_listings AS listing
     JOIN organizations AS organization ON organization.id = listing.organization_id
     LEFT JOIN garments AS garment ON garment.id = listing.garment_id
     WHERE ${whereSql}`,
    params,
  );
  const pageParams = [...params, query.limit, query.offset];
  const page = await client.query<{ id: string }>(
    `SELECT listing.id
     FROM commercial_listings AS listing
     JOIN organizations AS organization ON organization.id = listing.organization_id
     LEFT JOIN garments AS garment ON garment.id = listing.garment_id
     WHERE ${whereSql}
     ORDER BY listing.published_at DESC, listing.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    pageParams,
  );
  const listings = [];
  for (const row of page.rows) listings.push(await loadListing(client, null, row.id));
  return { listings, total: Number(total.rows[0]?.total ?? 0) };
}

async function loadBusiness(client: PoolClient, actorUserId: string | null, organizationId: string) {
  const organization = await client.query<{ id: string; name: string; slug: string; kind: OrganizationKind; status: string }>(
    `SELECT id, name, slug, kind, status FROM organizations WHERE id = $1`,
    [organizationId],
  );
  const row = organization.rows[0];
  if (!row || row.status !== "active") throw notFound("Business was not found.");
  const membership = actorUserId ? await activeMembership(client, actorUserId, organizationId) : null;
  const profile = await client.query<{
    description: string;
    inquiry_note: string;
    logo_media_id: string | null;
    publication: "draft" | "published";
  }>(
    `SELECT description, inquiry_note, logo_media_id, publication FROM organization_profiles WHERE organization_id = $1`,
    [organizationId],
  );
  const stored = profile.rows[0];
  const publication = stored?.publication ?? "draft";
  if (!membership && publication !== "published") throw notFound("Business was not found.");
  const specialties = await client.query<{ kind: string }>(
    `SELECT kind FROM organization_specialties WHERE organization_id = $1 ORDER BY kind`,
    [organizationId],
  );
  let logoMediaId: string | null = null;
  if (stored?.logo_media_id) {
    const media = await client.query<{ visibility: string }>(`SELECT visibility FROM media_assets WHERE id = $1`, [
      stored.logo_media_id,
    ]);
    if (membership || media.rows[0]?.visibility === "public") logoMediaId = stored.logo_media_id;
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    specialties: specialties.rows.length > 0 ? specialties.rows.map((item) => item.kind) : [row.kind],
    description: stored?.description ?? "",
    inquiryNote: membership || publication === "published" ? (stored?.inquiry_note ?? "") : "",
    logoMediaId,
    publication,
    verified: false,
    role: membership?.role ?? null,
  };
}

async function loadListing(client: PoolClient, actorUserId: string | null, listingId: string) {
  const found = await client.query<{
    id: string;
    organization_id: string;
    offering: string;
    title: string;
    description: string;
    status: ListingStatus;
    garment_id: string | null;
    size_label_id: string | null;
    design_revision_id: string | null;
    pricing_method: PricingMethod;
    currency: string | null;
    amount_minor: number | null;
    amount_max_minor: number | null;
    availability: string;
    customization_note: string;
    turnaround_note: string;
    published_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT id, organization_id, offering, title, description, status, garment_id, size_label_id,
            design_revision_id, pricing_method, currency, amount_minor, amount_max_minor, availability,
            customization_note, turnaround_note, published_at, updated_at
     FROM commercial_listings WHERE id = $1`,
    [listingId],
  );
  const listing = found.rows[0];
  if (!listing) throw notFound("Listing was not found.");
  const membership = actorUserId ? await activeMembership(client, actorUserId, listing.organization_id) : null;
  if (!membership && listing.status !== "published") throw notFound("Listing was not found.");
  const organization = await client.query<{ name: string; slug: string; kind: string }>(
    `SELECT name, slug, kind FROM organizations WHERE id = $1 AND status = 'active'`,
    [listing.organization_id],
  );
  const business = organization.rows[0];
  if (!business) throw notFound("Listing was not found.");
  return {
    id: listing.id,
    organization: { id: listing.organization_id, name: business.name, slug: business.slug, kind: business.kind },
    offering: listing.offering,
    title: listing.title,
    description: listing.description,
    status: listing.status,
    garment: await publicGarment(client, listing.garment_id),
    size: await sizeView(client, listing.size_label_id),
    design: await publicDesign(client, listing.design_revision_id),
    pricing: {
      method: listing.pricing_method,
      currency: listing.currency,
      amountMinor: listing.amount_minor,
      amountMaxMinor: listing.amount_max_minor,
      converted: false,
    },
    availability: listing.availability,
    customizationNote: listing.customization_note,
    turnaroundNote: listing.turnaround_note,
    media: await listingMedia(client, listing.id, Boolean(membership)),
    verified: false,
    role: membership?.role ?? null,
    updatedAt: listing.updated_at.toISOString(),
  };
}

async function normalizeListing(client: PoolClient, actorUserId: string, organizationId: string, input: ListingInput) {
  if (!offerings.has(input.offering)) throw invalid("invalid_offering", "Choose a supported offering.");
  const title = input.title.trim();
  if (!title || title.length > 120) throw invalid("invalid_title", "Listing title is required.");
  const description = input.description.trim();
  if (description.length > 2000) throw invalid("invalid_description", "Description is too long.");
  const customizationNote = input.customizationNote.trim();
  const turnaroundNote = input.turnaroundNote.trim();
  if (customizationNote.length > 500 || turnaroundNote.length > 500) {
    throw invalid("invalid_description", "That note is too long.");
  }
  if (!availabilityValues.has(input.availability)) throw invalid("invalid_availability", "Availability is not supported.");
  const price = priceOf(input);
  const garmentId = input.garmentId;
  let sizeLabelId: string | null = null;
  if (input.offering === "ready_to_wear" && !garmentId) throw invalid("missing_garment", "A ready-to-wear listing needs a garment.");
  if (garmentId) {
    await getCatalogGarment(client, actorUserId, garmentId);
    if (input.size) sizeLabelId = await requireGarmentSize(client, garmentId, input.size);
  } else if (input.size) {
    throw invalid("unknown_size", "A size needs a garment.");
  }
  const designRevisionId = input.designRevisionId;
  if (input.offering === "design_commission" && !designRevisionId) {
    throw invalid("missing_design", "A design commission needs a design revision owned by this business.");
  }
  if (designRevisionId) await assertOrganizationRevision(client, organizationId, designRevisionId);
  return {
    offering: input.offering,
    title,
    description,
    garmentId,
    sizeLabelId,
    designRevisionId,
    availability: input.availability,
    customizationNote,
    turnaroundNote,
    ...price,
  };
}

function priceOf(input: ListingInput) {
  if (!methods.has(input.pricingMethod)) throw invalid("invalid_price", "Choose fixed, starting, range, or quote.");
  if (input.pricingMethod === "quote") {
    if (input.currency || input.amountMinor !== null || input.amountMaxMinor !== null) {
      throw invalid("invalid_price", "A quote listing has no price.");
    }
    return { pricingMethod: "quote" as const, currency: null, amountMinor: null, amountMaxMinor: null };
  }
  const currency = input.currency ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) throw invalid("invalid_currency", "Use a three-letter currency code.");
  const amount = minor(input.amountMinor);
  if (input.pricingMethod === "range") {
    const max = minor(input.amountMaxMinor);
    if (max < amount) throw invalid("invalid_price", "The top of the range is below the starting amount.");
    return { pricingMethod: "range" as const, currency, amountMinor: amount, amountMaxMinor: max };
  }
  if (input.amountMaxMinor !== null) throw invalid("invalid_price", "That pricing method has one amount.");
  return { pricingMethod: input.pricingMethod as "fixed" | "starting", currency, amountMinor: amount, amountMaxMinor: null };
}

function minor(value: number | null): number {
  if (value === null || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw invalid("invalid_price", "Enter a non-negative whole amount in minor currency units.");
  }
  return value;
}

async function requireGarmentSize(client: PoolClient, garmentId: string, size: { system: string; label: string }) {
  const found = await client.query<{ id: string }>(
    `SELECT size_labels.id
     FROM garment_size_labels
     JOIN size_labels ON size_labels.id = garment_size_labels.size_label_id
     JOIN size_systems ON size_systems.id = size_labels.size_system_id
     WHERE garment_size_labels.garment_id = $1 AND size_systems.slug = $2 AND size_labels.label = $3`,
    [garmentId, size.system, size.label],
  );
  const id = found.rows[0]?.id;
  if (!id) throw invalid("unknown_size", "That size is not assigned to the garment.");
  return id;
}

async function assertOrganizationRevision(client: PoolClient, organizationId: string, revisionId: string) {
  const found = await client.query(
    `SELECT project.owner_organization_id
     FROM design_revisions AS revision
     JOIN design_projects AS project ON project.id = revision.design_project_id
     WHERE revision.id = $1`,
    [revisionId],
  );
  if (found.rows[0]?.owner_organization_id !== organizationId) throw notFound("Design revision was not found.");
}

async function assertOrganizationMedia(client: PoolClient, organizationId: string, mediaId: string) {
  const found = await client.query(`SELECT id FROM media_assets WHERE id = $1 AND owner_organization_id = $2`, [
    mediaId,
    organizationId,
  ]);
  if (!found.rows[0]) throw notFound("Media was not found.");
}

async function publicGarment(client: PoolClient, garmentId: string | null) {
  if (!garmentId) return null;
  const garment = await client.query<{ name: string; type_slug: string | null }>(
    `SELECT garment.name, type_term.slug AS type_slug
     FROM garments AS garment
     LEFT JOIN fashion_terms AS type_term ON type_term.id = garment.garment_type_id
     WHERE garment.id = $1`,
    [garmentId],
  );
  const row = garment.rows[0];
  if (!row) return null;
  const terms = await client.query<{ kind: string; slug: string; name: string }>(
    `SELECT fashion_terms.kind, fashion_terms.slug, fashion_terms.name
     FROM garment_terms
     JOIN fashion_terms ON fashion_terms.id = garment_terms.term_id
     WHERE garment_terms.garment_id = $1
       AND fashion_terms.kind IN ('garment_type', 'material', 'style', 'tradition', 'category', 'color', 'pattern')
     ORDER BY fashion_terms.kind, fashion_terms.slug`,
    [garmentId],
  );
  return { id: garmentId, name: row.name, typeSlug: row.type_slug, terms: terms.rows };
}

async function publicDesign(client: PoolClient, revisionId: string | null) {
  if (!revisionId) return null;
  const found = await client.query<{ project_id: string; project_name: string; revision_number: number }>(
    `SELECT project.id AS project_id, project.name AS project_name, revision.revision_number
     FROM design_revisions AS revision
     JOIN design_projects AS project ON project.id = revision.design_project_id
     WHERE revision.id = $1`,
    [revisionId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return { revisionId, projectId: row.project_id, projectName: row.project_name, revisionNumber: row.revision_number };
}

async function sizeView(client: PoolClient, sizeLabelId: string | null) {
  if (!sizeLabelId) return null;
  const found = await client.query<{ system: string; label: string }>(
    `SELECT size_systems.slug AS system, size_labels.label
     FROM size_labels
     JOIN size_systems ON size_systems.id = size_labels.size_system_id
     WHERE size_labels.id = $1`,
    [sizeLabelId],
  );
  return found.rows[0] ?? null;
}

async function listingMedia(client: PoolClient, listingId: string, member: boolean) {
  const rows = await client.query<{ media_id: string; visibility: string }>(
    `SELECT link.media_id, media.visibility
     FROM commercial_listing_media AS link
     JOIN media_assets AS media ON media.id = link.media_id
     WHERE link.listing_id = $1
     ORDER BY link.media_id`,
    [listingId],
  );
  return rows.rows.filter((row) => member || row.visibility === "public").map((row) => ({ id: row.media_id, visibility: row.visibility }));
}

async function lockListing(client: PoolClient, listingId: string) {
  const found = await client.query<{ organization_id: string; status: ListingStatus }>(
    `SELECT organization_id, status FROM commercial_listings WHERE id = $1 FOR UPDATE`,
    [listingId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Listing was not found.");
  return row;
}

async function ensureProfile(client: PoolClient, organizationId: string) {
  await client.query(`INSERT INTO organization_profiles (organization_id) VALUES ($1) ON CONFLICT DO NOTHING`, [organizationId]);
}

async function assertMember(client: PoolClient, actorUserId: string, organizationId: string) {
  const membership = await activeMembership(client, actorUserId, organizationId);
  if (!membership) throw notFound("Business was not found.");
  return membership;
}

async function assertPublisher(client: PoolClient, actorUserId: string, organizationId: string) {
  const membership = await assertMember(client, actorUserId, organizationId);
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw forbidden("Only an owner or admin can publish for this business.");
  }
  return membership;
}

function termExists(params: unknown[], kind: string, slug: string): string {
  params.push(kind, slug);
  const kindRef = `$${params.length - 1}`;
  const slugRef = `$${params.length}`;
  return `EXISTS (
    SELECT 1 FROM garment_terms AS garment_term
    JOIN fashion_terms AS term ON term.id = garment_term.term_id
    WHERE garment_term.garment_id = garment.id AND term.kind = ${kindRef} AND term.slug = ${slugRef}
  )`;
}
