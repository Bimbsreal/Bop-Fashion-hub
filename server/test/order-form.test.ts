import assert from "node:assert/strict";
import { test } from "node:test";
import { businessStatusActions, customerCanCancel, orderPriceLabel, prepareOrder } from "../../lib/order-form";

test("order drafts omit a client price and require custom notes", () => {
  const ready = prepareOrder({ listingId: "listing", offering: "ready_to_wear", quantity: "2", customizationNote: "" });
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  assert.equal(ready.body.quantity, 2);
  assert.equal("amountMinor" in ready.body, false);
  const missing = prepareOrder({ listingId: "listing", offering: "custom_service", quantity: "1", customizationNote: "  " });
  assert.equal(missing.ok, false);
  const fraction = prepareOrder({ listingId: "listing", offering: "ready_to_wear", quantity: "1.5", customizationNote: "" });
  assert.equal(fraction.ok, false);
});

test("order actions follow role and state", () => {
  assert.equal(customerCanCancel("submitted"), true);
  assert.equal(customerCanCancel("confirmed"), false);
  assert.deepEqual(businessStatusActions("submitted", "ready_to_wear", "fixed", "member"), []);
  assert.deepEqual(businessStatusActions("submitted", "ready_to_wear", "fixed", "owner"), ["confirmed", "rejected"]);
  assert.deepEqual(businessStatusActions("confirmed", "made_to_order", "fixed", "admin"), ["in_production"]);
  assert.equal(orderPriceLabel({ method: "quote", currency: null, agreedAmountMinor: null, unitAmountMinor: null, quantity: 1 }), "Quotation required");
  assert.equal(
    orderPriceLabel({ method: "fixed", currency: "NGN", agreedAmountMinor: 5000, unitAmountMinor: 2500, quantity: 2 }),
    "NGN 5000 (2 × 2500)",
  );
});
