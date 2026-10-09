export type ProviderFailureCategory = "timeout" | "invalid_response" | "permanent" | "retryable" | "unavailable";

export type AdapterInitialize =
  | { ok: true; providerReference: string }
  | { ok: false; category: ProviderFailureCategory };

export type AdapterConfirm =
  | { ok: true; verified: boolean; reportedState: "captured" | "failed" | "pending"; eventId: string }
  | { ok: false; category: ProviderFailureCategory };

export type PaymentAdapter = {
  readonly id: "development";
  readonly simulated: true;
  initialize(): Promise<AdapterInitialize>;
  confirm(intentId: string): Promise<AdapterConfirm>;
  fail(intentId: string): Promise<AdapterConfirm>;
};

export function developmentAdapter(): PaymentAdapter {
  return {
    id: "development",
    simulated: true,
    async initialize() {
      return { ok: true, providerReference: `devref.${cryptoRandom()}` };
    },
    async confirm(intentId: string) {
      return { ok: true, verified: true, reportedState: "captured", eventId: `dev.confirm.${intentId}` };
    },
    async fail(intentId: string) {
      return { ok: true, verified: true, reportedState: "failed", eventId: `dev.fail.${intentId}` };
    },
  };
}

export function simulationAllowed(nodeEnv: string, requested: boolean): boolean {
  return requested && nodeEnv !== "production";
}

function cryptoRandom(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
