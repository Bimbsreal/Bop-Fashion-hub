const payable = new Set(["confirmed", "in_production", "ready_for_fulfillment", "completed"]);

export function canRequestPayment(status: string, agreedAmountMinor: number | null, currency: string | null): boolean {
  return payable.has(status) && agreedAmountMinor !== null && currency !== null && /^[A-Z]{3}$/.test(currency);
}

export function preparePayment(orderId: string): { orderId: string } {
  return { orderId };
}

export function simulatedPaymentLabel(state: string): string {
  if (state === "captured") return "Simulated confirmation stored. This is not a card charge, and the order is not marked paid.";
  if (state === "pending") return "Simulated payment requested. No money has moved.";
  if (state === "failed") return "The simulated payment failed. No money moved.";
  if (state === "cancelled") return "The simulated payment was cancelled. No money moved.";
  return "This payment record is simulated. No money has moved.";
}
