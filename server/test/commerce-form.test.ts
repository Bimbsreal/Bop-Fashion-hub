import assert from "node:assert/strict";
import { test } from "node:test";
import { canPublish, prepareListingDraft, priceLabel, statusActions, type DraftFields } from "../../lib/commerce-form";

const base: DraftFields = {
  offering: "custom_service",
  title: "Alterations",
  description: "",
  garmentId: "",
  designRevisionId: "",
  pricingMethod: "quote",
  currency: "",
  amountMinor: "",
  amountMaxMinor: "",
  availability: "unspecified",
  customizationNote: "",
  turnaroundNote: "",
};

test("a quote draft omits currency and amounts", () => {
  const prepared = prepareListingDraft(base);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.body.pricingMethod, "quote");
  assert.equal("currency" in prepared.body, false);
  assert.equal("amountMinor" in prepared.body, false);
});

test("pricing rejects lowercase currency, fractions, and negatives", () => {
  const lower = prepareListingDraft({ ...base, pricingMethod: "fixed", currency: "ngn", amountMinor: "100" });
  assert.equal(lower.ok, false);
  const fraction = prepareListingDraft({ ...base, pricingMethod: "fixed", currency: "NGN", amountMinor: "10.5" });
  assert.equal(fraction.ok, false);
  const negative = prepareListingDraft({ ...base, pricingMethod: "starting", currency: "NGN", amountMinor: "-1" });
  assert.equal(negative.ok, false);
});

test("a price range keeps minor-unit bounds", () => {
  const backwards = prepareListingDraft({
    ...base,
    pricingMethod: "range",
    currency: "NGN",
    amountMinor: "1500",
    amountMaxMinor: "500",
  });
  assert.equal(backwards.ok, false);
  const prepared = prepareListingDraft({
    ...base,
    pricingMethod: "range",
    currency: "NGN",
    amountMinor: "500",
    amountMaxMinor: "1500",
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.body.amountMinor, 500);
  assert.equal(prepared.body.amountMaxMinor, 1500);
});

test("ready-to-wear and design commission require their references", () => {
  const garment = prepareListingDraft({ ...base, offering: "ready_to_wear" });
  assert.equal(garment.ok, false);
  const design = prepareListingDraft({ ...base, offering: "design_commission" });
  assert.equal(design.ok, false);
});

test("publication actions follow role and status", () => {
  assert.equal(canPublish("member"), false);
  assert.deepEqual(statusActions("draft", "member"), []);
  assert.deepEqual(statusActions("draft", "owner"), ["published", "archived"]);
  assert.deepEqual(statusActions("published", "admin"), ["paused", "archived"]);
  assert.deepEqual(statusActions("paused", "owner"), ["published", "archived"]);
  assert.deepEqual(statusActions("archived", "owner"), []);
});

test("price labels keep the stored currency", () => {
  assert.equal(priceLabel({ method: "quote", currency: null, amountMinor: null, amountMaxMinor: null }), "Quote required");
  assert.equal(priceLabel({ method: "fixed", currency: "NGN", amountMinor: 2500000, amountMaxMinor: null }), "NGN 2500000");
  assert.equal(priceLabel({ method: "starting", currency: "USD", amountMinor: 9000, amountMaxMinor: null }), "From USD 9000");
});
