import { emptyAnalysisDocument, fixtureAnalysisDocument } from "./garment-analysis";
import { ProviderFailure, type AiProvider, type ProviderRequest, type ProviderResult } from "./ai-provider";

const summary = "Simulated test result. No AI model was called and no image was produced.";

export type TestProvider = AiProvider & { idempotencyKeys: string[] };

export function createTestProvider(): TestProvider {
  const idempotencyKeys: string[] = [];
  return {
    id: "test",
    simulated: true,
    idempotencyKeys,
    capabilities() {
      return [
        { id: "test.orchestration", simulated: true },
        { id: "fashion.garment_attribute_extraction", simulated: true },
      ];
    },
    available() {
      return true;
    },
    execute(request) {
      idempotencyKeys.push(request.idempotencyKey);
      if (request.capability === "fashion.garment_attribute_extraction") return runAnalysis(request.input.outcome);
      return runOutcome(request);
    },
  };
}

function analysisResult(document: unknown): ProviderResult {
  return {
    modelId: null,
    simulated: true,
    summary: "Simulated garment-attribute fixture. No model was called and the image was not inspected.",
    document,
    usage: {
      source: "unreported",
      inputUnits: null,
      outputUnits: null,
      imageCount: null,
      costMinor: null,
      currency: null,
    },
  };
}

function runAnalysis(outcome: string | null): Promise<ProviderResult> {
  if (outcome === null || outcome === "succeed") return Promise.resolve(analysisResult(emptyAnalysisDocument()));
  if (outcome === "fixture") return Promise.resolve(analysisResult(fixtureAnalysisDocument()));
  if (outcome === "partial") {
    return Promise.resolve(analysisResult({ attributes: { pattern: { value: null, basis: "unknown", note: "" } } }));
  }
  if (outcome === "malformed") return Promise.resolve(analysisResult({ attributes: [] }));
  if (outcome === "invalid_type") {
    const document = emptyAnalysisDocument();
    document.attributes.primary_type = { value: 12, basis: "inferred", note: "Simulated fixture. This was not read from the image." };
    return Promise.resolve(analysisResult(document));
  }
  return runOutcome({ input: { outcome } } as ProviderRequest);
}

function runOutcome(request: ProviderRequest): Promise<ProviderResult> {
  switch (request.input.outcome) {
    case "succeed":
      return Promise.resolve({
        modelId: null,
        simulated: true,
        summary,
        usage: {
          source: "unreported",
          inputUnits: null,
          outputUnits: null,
          imageCount: null,
          costMinor: null,
          currency: null,
        },
      });
    case "temporary_failure":
      return Promise.reject(new ProviderFailure("temporary_network", "Simulated temporary failure."));
    case "permanent_failure":
      return Promise.reject(new ProviderFailure("permanent", "Simulated permanent failure."));
    case "timeout":
      return Promise.reject(new ProviderFailure("timeout", "Simulated timeout."));
    case "unsupported":
      return Promise.reject(new ProviderFailure("unsupported_capability", "Simulated unsupported capability."));
    case "hang":
      return new Promise(() => undefined);
    default:
      return Promise.reject(new ProviderFailure("invalid_request", "Outcome is not recognized."));
  }
}
