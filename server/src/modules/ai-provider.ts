export const errorCategories = [
  "temporary_network",
  "rate_limited",
  "timeout",
  "invalid_request",
  "unsupported_capability",
  "authentication",
  "quota",
  "invalid_response",
  "permanent",
] as const;

export type ErrorCategory = (typeof errorCategories)[number];

const retryable = new Set<ErrorCategory>(["temporary_network", "rate_limited", "timeout"]);

export function isRetryable(category: ErrorCategory): boolean {
  return retryable.has(category);
}

export class ProviderFailure extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.name = "ProviderFailure";
    this.category = category;
  }
}

export type UsageReport = {
  source: "provider" | "estimate" | "unreported";
  inputUnits: number | null;
  outputUnits: number | null;
  imageCount: number | null;
  costMinor: number | null;
  currency: string | null;
};

export type ProviderRequest = {
  taskId: string;
  capability: string;
  attempt: number;
  idempotencyKey: string;
  input: {
    outcome: string | null;
    mediaIds: string[];
    designProjectId: string | null;
  };
};

export type ProviderResult = {
  modelId: string | null;
  simulated: boolean;
  summary: string;
  usage: UsageReport;
  document?: unknown;
};

export type AiProvider = {
  id: string;
  simulated: boolean;
  capabilities(): { id: string; simulated: boolean }[];
  available(): boolean;
  execute(request: ProviderRequest): Promise<ProviderResult>;
};

export function normalizeFailure(error: unknown): { category: ErrorCategory; message: string } {
  if (error instanceof ProviderFailure) {
    return { category: error.category, message: safeMessage(error.message) };
  }
  return { category: "permanent", message: "The attempt failed." };
}

export function selectProvider(providers: AiProvider[], capability: string): AiProvider | null {
  return (
    providers.find(
      (provider) => provider.available() && provider.capabilities().some((item) => item.id === capability),
    ) ?? null
  );
}

function safeMessage(message: string): string {
  const trimmed = message.trim().slice(0, 240);
  return trimmed || "The attempt failed.";
}
