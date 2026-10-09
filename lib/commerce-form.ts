const offerings = new Set(["ready_to_wear", "made_to_order", "custom_service", "design_commission"]);
const methods = new Set(["fixed", "starting", "range", "quote"]);
const availabilityValues = new Set(["available", "unavailable", "unspecified"]);

export type DraftFields = {
  offering: string;
  title: string;
  description: string;
  garmentId: string;
  designRevisionId: string;
  pricingMethod: string;
  currency: string;
  amountMinor: string;
  amountMaxMinor: string;
  availability: string;
  customizationNote: string;
  turnaroundNote: string;
};

export function canPublish(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

export function statusActions(status: string, role: string | null): string[] {
  if (!canPublish(role)) return [];
  if (status === "draft") return ["published", "archived"];
  if (status === "published") return ["paused", "archived"];
  if (status === "paused") return ["published", "archived"];
  return [];
}

export function prepareListingDraft(
  fields: DraftFields,
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const title = fields.title.trim();
  if (!title) return { ok: false, message: "Listing title is required." };
  if (!offerings.has(fields.offering)) return { ok: false, message: "Choose a supported offering." };
  if (!availabilityValues.has(fields.availability)) return { ok: false, message: "Availability is not supported." };
  const garmentId = fields.garmentId.trim();
  const designRevisionId = fields.designRevisionId.trim();
  if (fields.offering === "ready_to_wear" && !garmentId) {
    return { ok: false, message: "A ready-to-wear listing needs a garment." };
  }
  if (fields.offering === "design_commission" && !designRevisionId) {
    return { ok: false, message: "A design commission needs a design revision owned by this business." };
  }
  const price = priceFields(fields);
  if (!price.ok) return price;
  return {
    ok: true,
    body: {
      offering: fields.offering,
      title,
      description: fields.description.trim(),
      ...(garmentId ? { garmentId } : {}),
      ...(designRevisionId ? { designRevisionId } : {}),
      pricingMethod: fields.pricingMethod,
      availability: fields.availability,
      customizationNote: fields.customizationNote.trim(),
      turnaroundNote: fields.turnaroundNote.trim(),
      ...price.body,
    },
  };
}

export function priceLabel(pricing: {
  method: string;
  currency: string | null;
  amountMinor: number | null;
  amountMaxMinor: number | null;
}): string {
  if (pricing.method === "quote" || !pricing.currency || pricing.amountMinor === null) return "Quote required";
  if (pricing.method === "starting") return `From ${pricing.currency} ${pricing.amountMinor}`;
  if (pricing.method === "range" && pricing.amountMaxMinor !== null) {
    return `${pricing.currency} ${pricing.amountMinor}–${pricing.amountMaxMinor}`;
  }
  return `${pricing.currency} ${pricing.amountMinor}`;
}

function priceFields(fields: DraftFields): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (!methods.has(fields.pricingMethod)) return { ok: false, message: "Choose fixed, starting, range, or quote." };
  const currency = fields.currency.trim();
  const amount = parseMinor(fields.amountMinor);
  const max = parseMinor(fields.amountMaxMinor);
  if (fields.pricingMethod === "quote") {
    if (currency || amount !== "missing" || max !== "missing") return { ok: false, message: "A quote listing has no price." };
    return { ok: true, body: {} };
  }
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, message: "Use a three-letter currency code." };
  if (amount === "missing" || amount === "invalid") {
    return { ok: false, message: "Enter a non-negative whole amount in minor currency units." };
  }
  if (fields.pricingMethod === "range") {
    if (max === "missing" || max === "invalid") {
      return { ok: false, message: "Enter a non-negative whole amount in minor currency units." };
    }
    if (max < amount) return { ok: false, message: "The top of the range is below the starting amount." };
    return { ok: true, body: { currency, amountMinor: amount, amountMaxMinor: max } };
  }
  if (max !== "missing") return { ok: false, message: "That pricing method has one amount." };
  return { ok: true, body: { currency, amountMinor: amount } };
}

function parseMinor(value: string): number | "missing" | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return "missing";
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const amount = Number(trimmed);
  if (!Number.isInteger(amount) || amount > 1_000_000_000) return "invalid";
  return amount;
}
