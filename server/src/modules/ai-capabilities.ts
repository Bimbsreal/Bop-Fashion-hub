import { invalid } from "../errors";
import { requireUuid } from "../http/body";
import type { AiProvider } from "./ai-provider";

export const fashionCapabilities = [
  "fashion.image_analysis",
  "fashion.design_generation",
  "fashion.image_variation",
  "fashion.garment_attribute_extraction",
  "fashion.virtual_try_on",
  "fashion.style_recommendation",
  "fashion.fit_analysis",
  "fashion.design_visualization",
] as const;

const imageCapabilities = new Set<string>([
  "fashion.image_analysis",
  "fashion.image_variation",
  "fashion.garment_attribute_extraction",
]);

const projectCapabilities = new Set<string>([
  "fashion.design_generation",
  "fashion.virtual_try_on",
  "fashion.style_recommendation",
  "fashion.fit_analysis",
]);

const outcomes = new Set(["succeed", "temporary_failure", "permanent_failure", "timeout", "unsupported", "hang"]);
const analysisOutcomes = new Set([
  "succeed",
  "fixture",
  "partial",
  "malformed",
  "invalid_type",
  "temporary_failure",
  "permanent_failure",
  "timeout",
  "unsupported",
  "hang",
]);

const privileged = new Set(["provider", "providerId", "model", "modelId", "parameters", "providerOptions", "apiKey", "credential"]);

export type NormalizedInput = {
  mediaIds: string[];
  designProjectId: string | null;
  outcome: string | null;
  note: string | null;
};

export type CapabilityView = {
  id: string;
  registered: true;
  configured: boolean;
  available: boolean;
  operational: false;
  disabled: false;
  simulated: boolean;
};

export function listCapabilities(providers: AiProvider[], testEnabled: boolean): CapabilityView[] {
  const ids = testEnabled ? [...fashionCapabilities, "test.orchestration"] : [...fashionCapabilities];
  return ids.map((id) => {
    const matches = providers.filter(
      (provider) => provider.available() && provider.capabilities().some((item) => item.id === id),
    );
    const simulated = matches.some((provider) => provider.simulated);
    return {
      id,
      registered: true,
      configured: matches.length > 0,
      available: matches.length > 0,
      operational: false,
      disabled: false,
      simulated,
    };
  });
}

export function parseTaskBody(
  body: Record<string, unknown>,
  testEnabled: boolean,
): { capability: string; input: NormalizedInput } {
  for (const key of Object.keys(body)) {
    if (privileged.has(key)) throw invalid("invalid_body", "Provider settings cannot be set on a task.");
  }
  const capability = body.capability;
  if (typeof capability !== "string" || !/^[a-z]+(?:\.[a-z_]+)+$/.test(capability)) {
    throw invalid("invalid_capability", "Capability is not registered.");
  }
  const known = new Set<string>(fashionCapabilities);
  if (testEnabled) known.add("test.orchestration");
  if (!known.has(capability)) throw invalid("invalid_capability", "Capability is not registered.");
  rejectUnknown(body, allowedKeys(capability, testEnabled));
  return { capability, input: parseInput(capability, body) };
}

function allowedKeys(capability: string, testEnabled: boolean): Set<string> {
  const keys = new Set(["capability", "organizationId"]);
  if (imageCapabilities.has(capability) || capability === "test.orchestration") keys.add("mediaIds");
  if (testEnabled && capability === "fashion.garment_attribute_extraction") keys.add("outcome");
  if (projectCapabilities.has(capability) || capability === "test.orchestration") keys.add("designProjectId");
  if (capability === "fashion.design_generation") keys.add("note");
  if (capability === "fashion.design_visualization") {
    keys.add("mediaIds");
    keys.add("designProjectId");
    keys.add("note");
  }
  if (capability === "test.orchestration") keys.add("outcome");
  return keys;
}

function rejectUnknown(body: Record<string, unknown>, allowed: Set<string>) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw invalid("invalid_body", "Unrecognized task field.");
  }
}

function parseInput(capability: string, body: Record<string, unknown>): NormalizedInput {
  if (capability === "fashion.garment_attribute_extraction") {
    return {
      mediaIds: mediaIds(body.mediaIds, 1, 1),
      designProjectId: null,
      outcome: body.outcome === undefined ? "succeed" : analysisOutcome(body.outcome),
      note: null,
    };
  }
  if (imageCapabilities.has(capability)) {
    return { mediaIds: mediaIds(body.mediaIds, 1, 4), designProjectId: null, outcome: null, note: null };
  }
  if (capability === "fashion.design_visualization") {
    return {
      mediaIds: optionalMediaIds(body.mediaIds),
      designProjectId: body.designProjectId === undefined ? null : requiredId(body.designProjectId),
      outcome: null,
      note: body.note === undefined ? null : boundedNote(body.note),
    };
  }
  if (capability === "fashion.design_generation") {
    return {
      mediaIds: [],
      designProjectId: requiredId(body.designProjectId),
      outcome: null,
      note: requiredNote(body.note),
    };
  }
  if (projectCapabilities.has(capability)) {
    return {
      mediaIds: [],
      designProjectId: requiredId(body.designProjectId),
      outcome: null,
      note: null,
    };
  }
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !outcomes.has(outcome)) {
    throw invalid("invalid_body", "Test outcome is not recognized.");
  }
  return {
    mediaIds: body.mediaIds === undefined ? [] : mediaIds(body.mediaIds, 0),
    designProjectId: body.designProjectId === undefined ? null : requiredId(body.designProjectId),
    outcome,
    note: null,
  };
}

function analysisOutcome(value: unknown): string {
  if (typeof value !== "string" || !analysisOutcomes.has(value)) {
    throw invalid("invalid_body", "Test outcome is not recognized.");
  }
  return value;
}

function mediaIds(value: unknown, minimum: number, maximum = 4): string[] {
  if (!Array.isArray(value)) throw invalid("invalid_body", "Media is required.");
  if (value.length < minimum || value.length > maximum) {
    throw invalid("invalid_body", maximum === 1 ? "Provide one image." : "Provide between 1 and 4 images.");
  }
  const ids = value.map((item) => {
    if (typeof item !== "string") throw invalid("invalid_body", "Media is required.");
    return requireUuid(item);
  });
  if (new Set(ids).size !== ids.length) throw invalid("invalid_body", "Media was repeated.");
  return ids;
}

function requiredId(value: unknown): string {
  if (typeof value !== "string") throw invalid("invalid_body", "Design project is required.");
  return requireUuid(value);
}

function optionalMediaIds(value: unknown): string[] {
  if (value === undefined) return [];
  return mediaIds(value, 0, 4);
}

function boundedNote(value: unknown): string | null {
  if (typeof value !== "string") throw invalid("invalid_body", "A design note is required.");
  const trimmed = value.trim();
  if (trimmed.length > 500) throw invalid("invalid_body", "A design note is required.");
  return trimmed || null;
}

function requiredNote(value: unknown): string {
  if (typeof value !== "string") throw invalid("invalid_body", "A design note is required.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500) throw invalid("invalid_body", "A design note is required.");
  return trimmed;
}
