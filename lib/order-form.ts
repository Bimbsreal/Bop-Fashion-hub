export function prepareOrder(input: {
  listingId: string;
  offering: string;
  quantity: string;
  customizationNote: string;
}): { ok: true; body: { listingId: string; quantity: number; customizationNote: string } } | { ok: false; message: string } {
  if (!input.listingId.trim()) return { ok: false, message: "Choose a published listing." };
  const note = input.customizationNote.trim();
  if ((input.offering === "custom_service" || input.offering === "design_commission") && !note) {
    return { ok: false, message: "Describe the custom work for this order." };
  }
  if (note.length > 500) return { ok: false, message: "Customization note is too long." };
  const quantity = quantityFor(input.offering, input.quantity);
  if (typeof quantity !== "number") return { ok: false, message: quantity };
  return { ok: true, body: { listingId: input.listingId, quantity, customizationNote: note } };
}

export function customerCanCancel(status: string): boolean {
  return (
    status === "submitted" ||
    status === "awaiting_business_review" ||
    status === "awaiting_quotation" ||
    status === "awaiting_customer_approval"
  );
}

export function businessStatusActions(status: string, offering: string, method: string, role: string | null): string[] {
  if (role !== "owner" && role !== "admin") return [];
  return allowed(offering, method, status).filter((item) => item !== "cancelled");
}

export function orderPriceLabel(pricing: {
  method: string;
  currency: string | null;
  agreedAmountMinor: number | null;
  unitAmountMinor: number | null;
  quantity: number;
}): string {
  if (pricing.agreedAmountMinor === null || !pricing.currency) return "Quotation required";
  if (pricing.unitAmountMinor !== null && pricing.quantity > 1) {
    return `${pricing.currency} ${pricing.agreedAmountMinor} (${pricing.quantity} × ${pricing.unitAmountMinor})`;
  }
  return `${pricing.currency} ${pricing.agreedAmountMinor}`;
}

function quantityFor(offering: string, value: string): number | string {
  const trimmed = value.trim();
  if (!trimmed) return offering === "ready_to_wear" ? 1 : 1;
  if (!/^\d+$/.test(trimmed)) return "Quantity must be a whole number from 1 to 20.";
  const quantity = Number(trimmed);
  if (quantity < 1 || quantity > 20) return "Quantity must be a whole number from 1 to 20.";
  if (offering !== "ready_to_wear" && quantity !== 1) return "This offering is ordered as a single request.";
  return quantity;
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
