import assert from "node:assert/strict";
import { test } from "node:test";
import { canRequestPayment, preparePayment, simulatedPaymentLabel } from "../../lib/payment-form";
import { simulationAllowed } from "../src/modules/payment-adapter";
import { currencyCode, minorExponent, wholeMinor } from "../src/modules/payment-money";
import { paymentTransitionAllowed } from "../src/modules/payments";

test("payment drafts omit a client amount and keep simulation off in production", () => {
  const body = preparePayment("order-1");
  assert.deepEqual(body, { orderId: "order-1" });
  assert.equal("amountMinor" in body, false);
  assert.equal("currency" in body, false);
  assert.equal(canRequestPayment("submitted", 5000, "NGN"), false);
  assert.equal(canRequestPayment("awaiting_customer_approval", null, null), false);
  assert.equal(canRequestPayment("confirmed", 5000, "NGN"), true);
  assert.equal(simulatedPaymentLabel("captured").includes("not marked paid"), true);
  assert.equal(simulationAllowed("production", true), false);
  assert.equal(simulationAllowed("test", true), true);
  assert.equal(simulationAllowed("development", false), false);
});

test("minor units stay integers and do not assume one exponent", () => {
  assert.equal(currencyCode("NGN"), true);
  assert.equal(currencyCode("ngn"), false);
  assert.equal(currencyCode("US"), false);
  assert.equal(minorExponent("NGN"), 2);
  assert.equal(minorExponent("JPY"), 0);
  assert.equal(minorExponent("KWD"), 3);
  assert.equal(minorExponent("XYZ"), null);
  assert.equal(wholeMinor(5000), true);
  assert.equal(wholeMinor(0.1 + 0.2), false);
  assert.equal(paymentTransitionAllowed("pending", "captured"), true);
  assert.equal(paymentTransitionAllowed("captured", "pending"), false);
  assert.equal(paymentTransitionAllowed("captured", "failed"), false);
  assert.equal(paymentTransitionAllowed("pending", "refunded"), false);
});
