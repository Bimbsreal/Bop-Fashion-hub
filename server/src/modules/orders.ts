import type { PoolClient } from "pg";
import { activeMembership } from "./access";
import { forbidden, invalid, notFound } from "../errors";
import type { MediaStorage } from "./storage";

const offerings = new Set(["ready_to_wear", "made_to_order", "custom_service", "design_commission"]);
const maxTotal = 1_000_000_000;

type OrderStatus =
  | "submitted"
  | "awaiting_business_review"
  | "awaiting_quotation"
  | "awaiting_customer_approval"
  | "confirmed"
  | "in_production"
  | "ready_for_fulfillment"
  | "completed"
  | "cancelled"
  | "rejected";

type ListingRow = {
  id: string;
  organization_id: string;
  offering: string;
  title: string;
  description: string;
  status: string;
  garment_id: string | null;
  size_label_id: string | null;
  design_revision_id: string | null;
  pricing_method: string;
  currency: string | null;
  amount_minor: number | null;
  amount_max_minor: number | null;
  availability: string;
  organization_status: string;
};

export async function submitOrder(
  client: PoolClient,
  actorUserId: string,
  input: {
    listingId: string;
    quantity: number;
    customizationNote: string;
    measurementIds: string[];
    mediaIds: string[];
    idempotencyKey: string | null;
  },
) {
  const listing = await lockListing(client, input.listingId);
  if (listing.status !== "published" || listing.organization_status !== "active") throw notFound("Listing was not found.");
  if (listing.availability === "unavailable") throw invalid("unavailable", "This listing is not available to order.");
  if (!offerings.has(listing.offering)) throw invalid("invalid_offering", "That offering cannot be ordered.");
  const quantity = cleanQuantity(listing.offering, input.quantity);
  const note = input.customizationNote.trim();
  if (note.length > 500) throw invalid("invalid_note", "Customization note is too long.");
  if ((listing.offering === "custom_service" || listing.offering === "design_commission") && !note) {
    throw invalid("missing_customization", "Describe the custom work for this order.");
  }
  if (input.measurementIds.length > 12 || input.mediaIds.length > 6) {
    throw invalid("invalid_body", "Too many references were attached.");
  }
  const existing = await findIdempotent(client, actorUserId, input.idempotencyKey);
  if (existing) {
    if (existing.listing_id !== listing.id) throw invalid("conflict", "That idempotency key was used for a different order.");
    return { order: await loadOrder(client, actorUserId, existing.id), duplicate: true };
  }
  const priced = priceSnapshot(listing, quantity);
  const status = initialStatus(listing.offering, listing.pricing_method);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO orders (
       customer_user_id, organization_id, listing_id, offering, title, description, status, pricing_method,
       currency, unit_amount_minor, agreed_amount_minor, list_currency, list_amount_minor, list_amount_max_minor,
       quantity, availability_snapshot, customization_note, garment_id, size_label_id, design_revision_id, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id`,
    [
      actorUserId,
      listing.organization_id,
      listing.id,
      listing.offering,
      listing.title,
      listing.description,
      status,
      listing.pricing_method,
      priced.currency,
      priced.unitAmountMinor,
      priced.agreedAmountMinor,
      listing.currency,
      listing.amount_minor,
      listing.amount_max_minor,
      quantity,
      listing.availability,
      note,
      listing.garment_id,
      listing.size_label_id,
      listing.design_revision_id,
      input.idempotencyKey,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw invalid("invalid_body", "The order could not be saved.");
  await recordEvent(client, id, actorUserId, null, status, "submitted", "");
  for (const measurementId of input.measurementIds) await shareMeasurement(client, id, actorUserId, measurementId);
  for (const mediaId of input.mediaIds) await attachMedia(client, id, actorUserId, mediaId);
  return { order: await loadOrder(client, actorUserId, id), duplicate: false };
}

export async function listCustomerOrders(client: PoolClient, actorUserId: string) {
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM orders WHERE customer_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
    [actorUserId],
  );
  const orders = [];
  for (const row of rows.rows) orders.push(await loadOrder(client, actorUserId, row.id));
  return orders;
}

export async function listBusinessOrders(client: PoolClient, actorUserId: string, organizationId: string) {
  const membership = await activeMembership(client, actorUserId, organizationId);
  if (!membership) throw notFound("Business was not found.");
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM orders WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
    [organizationId],
  );
  const orders = [];
  for (const row of rows.rows) orders.push(await loadOrder(client, actorUserId, row.id));
  return orders;
}

export async function requireOrder(client: PoolClient, actorUserId: string, orderId: string) {
  return loadOrder(client, actorUserId, orderId);
}

export async function changeOrderStatus(client: PoolClient, actorUserId: string, orderId: string, next: string) {
  const current = await lockOrder(client, orderId);
  await assertBusinessActor(client, actorUserId, current);
  if (next === "cancelled") throw invalid("invalid_transition", "Use the cancellation action.");
  if (!allowed(current.offering, current.pricing_method, current.status).includes(next)) {
    throw invalid("invalid_transition", "That order status change is not available.");
  }
  if (next === "confirmed" && current.agreed_amount_minor === null) {
    throw invalid("invalid_transition", "Confirm the agreed price before this order can be confirmed.");
  }
  await applyStatus(client, actorUserId, current.id, current.status, next as OrderStatus, "status", "");
  return loadOrder(client, actorUserId, current.id);
}

export async function cancelOrder(client: PoolClient, actorUserId: string, orderId: string) {
  const current = await lockOrder(client, orderId);
  const membership = await activeMembership(client, actorUserId, current.organization_id);
  const customer = current.customer_user_id === actorUserId;
  if (!customer && !membership) throw notFound("Order was not found.");
  if (membership && membership.role !== "owner" && membership.role !== "admin" && !customer) {
    throw forbidden("Only an owner or admin can cancel for this business.");
  }
  if (!allowed(current.offering, current.pricing_method, current.status).includes("cancelled")) {
    throw invalid("invalid_transition", "Cancellation terms are not recorded for this order state.");
  }
  await applyStatus(client, actorUserId, current.id, current.status, "cancelled", "status", "");
  return loadOrder(client, actorUserId, current.id);
}

export async function issueQuotation(
  client: PoolClient,
  actorUserId: string,
  orderId: string,
  input: { currency: string; amountMinor: number; note: string; expiresAt: Date | null },
) {
  const current = await lockOrder(client, orderId);
  await assertBusinessActor(client, actorUserId, current);
  if (current.pricing_method === "fixed") throw invalid("invalid_price", "This order already has an agreed price.");
  if (current.status !== "awaiting_quotation" && current.status !== "awaiting_customer_approval") {
    throw invalid("invalid_transition", "A quotation cannot be issued for this order state.");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw invalid("invalid_currency", "Use a three-letter currency code.");
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0 || input.amountMinor > maxTotal) {
    throw invalid("invalid_price", "Enter a non-negative whole amount in minor currency units.");
  }
  if (input.note.trim().length > 500) throw invalid("invalid_note", "Quotation note is too long.");
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw invalid("invalid_expiration", "The quotation expiration must be in the future.");
  }
  assertQuoteBounds(current, input.currency, input.amountMinor);
  const accepted = await client.query(
    `SELECT id FROM order_quotations WHERE order_id = $1 AND status = 'accepted'`,
    [orderId],
  );
  if (accepted.rows.length > 0) throw invalid("invalid_transition", "An accepted quotation cannot be replaced.");
  await client.query(
    `UPDATE order_quotations SET status = 'superseded' WHERE order_id = $1 AND status IN ('issued', 'expired')`,
    [orderId],
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO order_quotations (order_id, issued_by_user_id, currency, amount_minor, note, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'issued') RETURNING id`,
    [orderId, actorUserId, input.currency, input.amountMinor, input.note.trim(), input.expiresAt],
  );
  const quoteId = inserted.rows[0]?.id;
  if (!quoteId) throw invalid("invalid_price", "The quotation could not be saved.");
  if (current.status === "awaiting_quotation") {
    await applyStatus(client, actorUserId, orderId, current.status, "awaiting_customer_approval", "quotation_issued", "");
  } else {
    await recordEvent(client, orderId, actorUserId, current.status, current.status, "quotation_issued", "");
  }
  return loadOrder(client, actorUserId, orderId);
}

export async function respondToQuotation(
  client: PoolClient,
  actorUserId: string,
  orderId: string,
  quotationId: string,
  decision: "accepted" | "rejected",
) {
  const current = await lockOrder(client, orderId);
  if (current.customer_user_id !== actorUserId) throw notFound("Order was not found.");
  if (current.status !== "awaiting_customer_approval") {
    throw invalid("invalid_transition", "This order is not waiting for a quotation response.");
  }
  const quote = await client.query<{ id: string; currency: string; amount_minor: number; status: string; expires_at: Date | null }>(
    `SELECT id, currency, amount_minor, status, expires_at FROM order_quotations WHERE id = $1 AND order_id = $2 FOR UPDATE`,
    [quotationId, orderId],
  );
  const row = quote.rows[0];
  if (!row || row.status !== "issued") throw notFound("Quotation was not found.");
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    throw invalid("expired_quotation", "That quotation has expired.");
  }
  if (decision === "rejected") {
    await client.query(`UPDATE order_quotations SET status = 'rejected' WHERE id = $1`, [row.id]);
    await applyStatus(client, actorUserId, orderId, current.status, "awaiting_quotation", "quotation_rejected", "");
    return loadOrder(client, actorUserId, orderId);
  }
  await client.query(`UPDATE order_quotations SET status = 'accepted' WHERE id = $1`, [row.id]);
  await client.query(
    `UPDATE order_quotations SET status = 'superseded' WHERE order_id = $1 AND id <> $2 AND status = 'issued'`,
    [orderId, row.id],
  );
  await client.query(
    `UPDATE orders SET currency = $2, agreed_amount_minor = $3, status = 'confirmed', updated_at = now() WHERE id = $1`,
    [orderId, row.currency, row.amount_minor],
  );
  await recordEvent(client, orderId, actorUserId, current.status, "confirmed", "quotation_accepted", "");
  return loadOrder(client, actorUserId, orderId);
}

export async function readOrderMedia(
  client: PoolClient,
  actorUserId: string,
  orderId: string,
  mediaId: string,
  storage: MediaStorage,
) {
  await loadOrder(client, actorUserId, orderId);
  const found = await client.query<{ storage_key: string; mime_type: string; original_filename: string; status: string }>(
    `SELECT media.storage_key, media.mime_type, media.original_filename, media.status
     FROM order_media AS link
     JOIN media_assets AS media ON media.id = link.media_id
     WHERE link.order_id = $1 AND link.media_id = $2`,
    [orderId, mediaId],
  );
  const row = found.rows[0];
  if (!row || row.status !== "ready") throw notFound("Media was not found.");
  try {
    const bytes = await storage.read(row.storage_key);
    return { bytes, mimeType: row.mime_type, filename: row.original_filename || "image" };
  } catch {
    throw notFound("Media was not found.");
  }
}

async function lockListing(client: PoolClient, listingId: string) {
  const found = await client.query<ListingRow>(
    `SELECT listing.id, listing.organization_id, listing.offering, listing.title, listing.description, listing.status,
            listing.garment_id, listing.size_label_id, listing.design_revision_id, listing.pricing_method,
            listing.currency, listing.amount_minor, listing.amount_max_minor, listing.availability,
            organization.status AS organization_status
     FROM commercial_listings AS listing
     JOIN organizations AS organization ON organization.id = listing.organization_id
     WHERE listing.id = $1
     FOR UPDATE OF listing`,
    [listingId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Listing was not found.");
  return row;
}

async function lockOrder(client: PoolClient, orderId: string) {
  const found = await client.query<{
    id: string;
    customer_user_id: string;
    organization_id: string;
    offering: string;
    status: OrderStatus;
    pricing_method: string;
    list_currency: string | null;
    list_amount_minor: number | null;
    list_amount_max_minor: number | null;
    quantity: number;
    agreed_amount_minor: number | null;
  }>(
    `SELECT id, customer_user_id, organization_id, offering, status, pricing_method, list_currency,
            list_amount_minor, list_amount_max_minor, quantity, agreed_amount_minor
     FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Order was not found.");
  return row;
}

async function loadOrder(client: PoolClient, actorUserId: string, orderId: string) {
  const found = await client.query<{
    id: string;
    customer_user_id: string;
    organization_id: string;
    listing_id: string;
    offering: string;
    title: string;
    description: string;
    status: string;
    pricing_method: string;
    currency: string | null;
    unit_amount_minor: number | null;
    agreed_amount_minor: number | null;
    list_currency: string | null;
    list_amount_minor: number | null;
    list_amount_max_minor: number | null;
    quantity: number;
    availability_snapshot: string;
    customization_note: string;
    garment_id: string | null;
    size_label_id: string | null;
    design_revision_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, customer_user_id, organization_id, listing_id, offering, title, description, status, pricing_method,
            currency, unit_amount_minor, agreed_amount_minor, list_currency, list_amount_minor, list_amount_max_minor,
            quantity, availability_snapshot, customization_note, garment_id, size_label_id, design_revision_id,
            created_at, updated_at
     FROM orders WHERE id = $1`,
    [orderId],
  );
  const order = found.rows[0];
  if (!order) throw notFound("Order was not found.");
  const membership = await activeMembership(client, actorUserId, order.organization_id);
  const customer = order.customer_user_id === actorUserId;
  if (!customer && !membership) throw notFound("Order was not found.");
  const organization = await client.query<{ name: string; slug: string }>(
    `SELECT name, slug FROM organizations WHERE id = $1`,
    [order.organization_id],
  );
  const business = organization.rows[0];
  if (!business) throw notFound("Order was not found.");
  const events = await client.query<{ id: string; from_status: string | null; to_status: string; kind: string; created_at: Date }>(
    `SELECT id, from_status, to_status, kind, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const quotations = await client.query<{
    id: string;
    currency: string;
    amount_minor: number;
    note: string;
    expires_at: Date | null;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, currency, amount_minor, note, expires_at, status, created_at
     FROM order_quotations WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const shares = await client.query<{ definition_slug: string; canonical_cm: string; entered_text: string; entered_unit: string }>(
    `SELECT definition_slug, canonical_cm::text AS canonical_cm, entered_text, entered_unit
     FROM order_measurement_shares WHERE order_id = $1 ORDER BY definition_slug, id`,
    [orderId],
  );
  const media = await client.query<{ media_id: string; visibility: string }>(
    `SELECT link.media_id, media.visibility
     FROM order_media AS link
     JOIN media_assets AS media ON media.id = link.media_id
     WHERE link.order_id = $1 ORDER BY link.media_id`,
    [orderId],
  );
  return {
    id: order.id,
    listingId: order.listing_id,
    offering: order.offering,
    title: order.title,
    description: order.description,
    status: order.status,
    quantity: order.quantity,
    customizationNote: order.customization_note,
    availability: order.availability_snapshot,
    stockReserved: false,
    paid: false,
    organization: { id: order.organization_id, name: business.name, slug: business.slug },
    garmentId: order.garment_id,
    sizeLabelId: order.size_label_id,
    design: await designView(client, order.design_revision_id),
    pricing: {
      method: order.pricing_method,
      currency: order.currency,
      unitAmountMinor: order.unit_amount_minor,
      agreedAmountMinor: order.agreed_amount_minor,
      listCurrency: order.list_currency,
      listAmountMinor: order.list_amount_minor,
      listAmountMaxMinor: order.list_amount_max_minor,
      converted: false,
    },
    measurements: shares.rows.map((row) => ({
      definition: row.definition_slug,
      canonicalCm: row.canonical_cm,
      enteredText: row.entered_text,
      enteredUnit: row.entered_unit,
    })),
    media: media.rows.map((row) => ({ id: row.media_id, visibility: row.visibility })),
    quotations: quotations.rows.map((row) => ({
      id: row.id,
      currency: row.currency,
      amountMinor: row.amount_minor,
      note: row.note,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    })),
    events: events.rows.map((row) => ({
      id: row.id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      kind: row.kind,
      createdAt: row.created_at.toISOString(),
    })),
    role: membership?.role ?? null,
    customer: customer,
    createdAt: order.created_at.toISOString(),
    updatedAt: order.updated_at.toISOString(),
  };
}

function initialStatus(offering: string, method: string): OrderStatus {
  if (method !== "fixed") return "awaiting_quotation";
  if (offering === "custom_service" || offering === "design_commission") return "awaiting_business_review";
  return "submitted";
}

function allowed(offering: string, method: string, status: string): string[] {
  const quoted = method !== "fixed";
  const service = offering === "custom_service" || offering === "design_commission";
  const production = offering !== "ready_to_wear";
  const map: Record<string, string[]> = {};
  if (quoted) {
    map.awaiting_quotation = ["rejected", "cancelled"];
    map.awaiting_customer_approval = ["cancelled"];
  } else if (service) {
    map.awaiting_business_review = ["confirmed", "rejected", "cancelled"];
  } else {
    map.submitted = ["confirmed", "rejected", "cancelled"];
  }
  if (production) {
    map.confirmed = ["in_production"];
    map.in_production = ["ready_for_fulfillment"];
  } else {
    map.confirmed = ["ready_for_fulfillment"];
  }
  map.ready_for_fulfillment = ["completed"];
  return map[status] ?? [];
}

function priceSnapshot(listing: ListingRow, quantity: number) {
  if (listing.pricing_method !== "fixed") {
    return { currency: null, unitAmountMinor: null, agreedAmountMinor: null };
  }
  if (!listing.currency || listing.amount_minor === null) throw invalid("invalid_price", "This listing has no agreed price.");
  return {
    currency: listing.currency,
    unitAmountMinor: listing.amount_minor,
    agreedAmountMinor: total(listing.amount_minor, quantity),
  };
}

function assertQuoteBounds(
  order: { pricing_method: string; list_currency: string | null; list_amount_minor: number | null; list_amount_max_minor: number | null; quantity: number },
  currency: string,
  amountMinor: number,
) {
  if (order.pricing_method === "quote") return;
  if (!order.list_currency || order.list_amount_minor === null) throw invalid("invalid_price", "This listing has no price bound.");
  if (currency !== order.list_currency) throw invalid("invalid_currency", "Use the listing currency.");
  const minimum = total(order.list_amount_minor, order.quantity);
  if (order.pricing_method === "starting" && amountMinor < minimum) {
    throw invalid("invalid_price", "The quotation is below the listing's starting amount.");
  }
  if (order.pricing_method === "range") {
    if (order.list_amount_max_minor === null) throw invalid("invalid_price", "This listing has no price bound.");
    const maximum = total(order.list_amount_max_minor, order.quantity);
    if (amountMinor < minimum || amountMinor > maximum) {
      throw invalid("invalid_price", "The quotation is outside the listing's price range.");
    }
  }
}

function total(unit: number, quantity: number): number {
  const amount = unit * quantity;
  if (!Number.isInteger(amount) || amount < 0 || amount > maxTotal) {
    throw invalid("invalid_price", "The order total is not a valid minor-unit amount.");
  }
  return amount;
}

function cleanQuantity(offering: string, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    throw invalid("invalid_quantity", "Quantity must be a whole number from 1 to 20.");
  }
  if (offering !== "ready_to_wear" && quantity !== 1) {
    throw invalid("invalid_quantity", "This offering is ordered as a single request.");
  }
  return quantity;
}

async function findIdempotent(client: PoolClient, actorUserId: string, key: string | null) {
  if (!key) return null;
  const found = await client.query<{ id: string; listing_id: string }>(
    `SELECT id, listing_id FROM orders WHERE customer_user_id = $1 AND idempotency_key = $2`,
    [actorUserId, key],
  );
  return found.rows[0] ?? null;
}

async function shareMeasurement(client: PoolClient, orderId: string, actorUserId: string, measurementId: string) {
  const found = await client.query<{ slug: string; canonical_cm: string; entered_text: string; entered_unit: string }>(
    `SELECT definition.slug, measurement.canonical_cm::text AS canonical_cm, measurement.entered_text, measurement.entered_unit
     FROM body_measurements AS measurement
     JOIN measurement_profiles AS profile ON profile.id = measurement.profile_id
     JOIN measurement_definitions AS definition ON definition.id = measurement.definition_id
     WHERE measurement.id = $1 AND profile.subject_user_id = $2 AND measurement.record_status = 'current'`,
    [measurementId, actorUserId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("Measurement was not found.");
  await client.query(
    `INSERT INTO order_measurement_shares (order_id, measurement_id, definition_slug, canonical_cm, entered_text, entered_unit)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, measurementId, row.slug, row.canonical_cm, row.entered_text, row.entered_unit],
  );
}

async function attachMedia(client: PoolClient, orderId: string, actorUserId: string, mediaId: string) {
  const found = await client.query(
    `SELECT id FROM media_assets WHERE id = $1 AND owner_user_id = $2 AND status = 'ready'`,
    [mediaId, actorUserId],
  );
  if (!found.rows[0]) throw notFound("Media was not found.");
  await client.query(`INSERT INTO order_media (order_id, media_id) VALUES ($1, $2)`, [orderId, mediaId]);
}

async function designView(client: PoolClient, revisionId: string | null) {
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

async function assertBusinessActor(
  client: PoolClient,
  actorUserId: string,
  order: { customer_user_id: string; organization_id: string },
) {
  const membership = await activeMembership(client, actorUserId, order.organization_id);
  if (order.customer_user_id !== actorUserId && !membership) throw notFound("Order was not found.");
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw forbidden("Only an owner or admin can update this order.");
  }
}

async function applyStatus(
  client: PoolClient,
  actorUserId: string,
  orderId: string,
  from: string,
  to: OrderStatus,
  kind: string,
  note: string,
) {
  await client.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1`, [orderId, to]);
  await recordEvent(client, orderId, actorUserId, from, to, kind, note);
}

async function recordEvent(
  client: PoolClient,
  orderId: string,
  actorUserId: string,
  from: string | null,
  to: string,
  kind: string,
  note: string,
) {
  await client.query(
    `INSERT INTO order_events (order_id, actor_user_id, from_status, to_status, kind, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, actorUserId, from, to, kind, note],
  );
}
