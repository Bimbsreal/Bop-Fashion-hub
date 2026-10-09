import { centimetresToHundredths } from "./measure-units";

export const fitRuleSetId = "fit-rules.v1";

export type FitClassification =
  | "potentially_compatible"
  | "potentially_restrictive"
  | "potentially_loose"
  | "mixed"
  | "insufficient_data"
  | "unsupported_garment"
  | "requires_verification";

export type FitSize = { system: string; label: string };

export type FitMapping = {
  bodyDefinition: string;
  garmentDefinition: string;
  label: string;
};

export const fitMappings: readonly FitMapping[] = [
  { bodyDefinition: "chest-circumference", garmentDefinition: "chest", label: "Chest circumference" },
  { bodyDefinition: "waist-circumference", garmentDefinition: "waist", label: "Waist circumference" },
  { bodyDefinition: "hip-circumference", garmentDefinition: "hip", label: "Hip circumference" },
  { bodyDefinition: "shoulder-width", garmentDefinition: "garment-shoulder", label: "Shoulder width" },
  { bodyDefinition: "sleeve-length", garmentDefinition: "garment-sleeve", label: "Sleeve length" },
  { bodyDefinition: "inseam", garmentDefinition: "garment-inseam", label: "Inseam" },
];

export const unsupportedGarmentCategories: Record<string, string> = {
  agbada: "Agbada is cut with design-specific volume. A circumference difference is not a fit rule for it.",
  kaftan: "A kaftan is a flowing garment. A circumference difference is not a fit rule for it.",
  gown: "A gown's fit depends on its cut. A circumference difference is not a fit rule for it.",
};

const unmappedGarmentCopy: Record<string, string> = {
  "garment-length": "Garment length is not compared with a body measurement. Those are different dimensions.",
  "garment-hem": "Hem width is not compared with a body measurement. Those are different dimensions.",
};

export type FitComparisonInput = {
  size: FitSize | null;
  bodyDefinition: string;
  garmentDefinition: string;
  bodyCm: string;
  garmentCm: string;
  bodySource: string;
  bodyVerification: "unverified" | "verified";
  bodyRecordedAt: string;
  garmentProvenance: string;
};

export type FitComparison = FitComparisonInput & {
  label: string;
  differenceCm: string;
};

export type FitNote = { kind: "missing" | "limitation" | "assumption"; message: string };

export type FitRuleResult = {
  classification: FitClassification;
  summary: string;
  easeApplied: false;
  fitGuarantee: false;
  comparisons: FitComparison[];
  notes: FitNote[];
  dimensionalProximity: {
    size: FitSize;
    absoluteDifferenceCm: string;
    message: string;
  } | null;
};

const assumption =
  "Rule set fit-rules.v1 does not include an ease allowance. A difference between a garment dimension and a body measurement is not a fit result.";

export function describeFitRules() {
  return {
    id: fitRuleSetId,
    easeRuleCount: 0,
    easeApplied: false as const,
    fitGuarantee: false as const,
    mappings: fitMappings.map((mapping) => ({ ...mapping })),
    unsupportedCategories: Object.entries(unsupportedGarmentCategories).map(([slug, reason]) => ({ slug, reason })),
  };
}

export function analyzeDimensions(input: {
  garmentCategory: string | null;
  comparisons: FitComparisonInput[];
  missing: { size: FitSize | null; mapping: FitMapping; absent: "body" | "garment" }[];
  unmappedGarmentDefinitions: string[];
  skippedAiDefinitions: string[];
}): FitRuleResult {
  const comparisons = input.comparisons.map((comparison) => ({
    ...comparison,
    label: mappingLabel(comparison.bodyDefinition, comparison.garmentDefinition),
    differenceCm: signedCentimetres(differenceHundredths(comparison.garmentCm, comparison.bodyCm)),
  }));
  const notes: FitNote[] = [{ kind: "assumption", message: assumption }];
  const unsupported = input.garmentCategory ? unsupportedGarmentCategories[input.garmentCategory] : undefined;

  for (const gap of input.missing) {
    const side = gap.absent === "body" ? "body measurement" : "garment dimension";
    const size = gap.size ? ` for size ${gap.size.label}` : "";
    notes.push({
      kind: "missing",
      message: `${gap.mapping.label} was not compared${size} because the ${side} is missing.`,
    });
  }
  for (const definition of unique(input.unmappedGarmentDefinitions)) {
    notes.push({
      kind: "limitation",
      message: unmappedGarmentCopy[definition] ?? `${definition} is not paired with a body measurement in this rule set.`,
    });
  }
  for (const definition of unique(input.skippedAiDefinitions)) {
    notes.push({
      kind: "limitation",
      message: `An AI-estimated ${definition} was not used.`,
    });
  }
  for (const comparison of uniqueBy(comparisons, (item) => `${item.bodyDefinition}:${item.bodyRecordedAt}:${item.bodySource}`)) {
    if (comparison.bodyVerification === "unverified") {
      notes.push({
        kind: "limitation",
        message: `${mappingLabel(comparison.bodyDefinition, comparison.garmentDefinition)} is ${sourcePhrase(comparison.bodySource)} and unverified.`,
      });
    }
  }
  if (comparisons.some((comparison) => comparison.differenceCm.startsWith("-"))) {
    notes.push({
      kind: "limitation",
      message: "A garment dimension smaller than the body measurement is not treated as a fit failure. Fabric stretch was not inferred.",
    });
  }
  if (directionsDisagree(comparisons)) {
    notes.push({
      kind: "limitation",
      message: "The compared dimensions do not all differ in the same direction. No ease rule resolves that disagreement.",
    });
  }

  const proximity = proximityFor(comparisons);
  let classification: FitClassification = "insufficient_data";
  let summary = "No body measurement and garment dimension could be compared. Fit was not assessed.";
  if (unsupported) {
    classification = "unsupported_garment";
    summary = `${unsupported} Dimensional differences, when shown, are not a judgment of fit.`;
  } else if (comparisons.length > 0) {
    const category = input.garmentCategory ?? "this garment";
    summary = `Dimensions were compared for ${category}. No ease rule is documented, so fit suitability was not classified.`;
  }

  return {
    classification,
    summary,
    easeApplied: false,
    fitGuarantee: false,
    comparisons,
    notes,
    dimensionalProximity: proximity,
  };
}

function mappingLabel(bodyDefinition: string, garmentDefinition: string): string {
  return (
    fitMappings.find((mapping) => mapping.bodyDefinition === bodyDefinition && mapping.garmentDefinition === garmentDefinition)?.label ??
    bodyDefinition
  );
}

function differenceHundredths(garmentCm: string, bodyCm: string): bigint {
  return centimetresToHundredths(normalizeCm(garmentCm)) - centimetresToHundredths(normalizeCm(bodyCm));
}

function signedCentimetres(hundredths: bigint): string {
  const negative = hundredths < BigInt(0);
  const absolute = negative ? -hundredths : hundredths;
  const whole = absolute / BigInt(100);
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

function normalizeCm(value: string): string {
  const [whole, fraction = ""] = value.trim().split(".");
  return `${whole}.${(fraction + "00").slice(0, 2)}`;
}

function directionsDisagree(comparisons: FitComparison[]): boolean {
  const groups = new Map<string, Set<string>>();
  for (const comparison of comparisons) {
    const key = comparison.size ? `${comparison.size.system}:${comparison.size.label}` : "unspecified";
    const direction = comparison.differenceCm.startsWith("-") ? "smaller" : comparison.differenceCm === "0.00" ? "equal" : "larger";
    const current = groups.get(key) ?? new Set<string>();
    current.add(direction);
    groups.set(key, current);
  }
  for (const directions of groups.values()) {
    if (directions.size > 1) return true;
  }
  return false;
}

function proximityFor(comparisons: FitComparison[]): FitRuleResult["dimensionalProximity"] {
  const groups = new Map<string, { size: FitSize; hundredths: bigint; definitions: string[] }>();
  for (const comparison of comparisons) {
    if (!comparison.size) continue;
    const key = `${comparison.size.system}:${comparison.size.label}`;
    const current = groups.get(key) ?? { size: comparison.size, hundredths: BigInt(0), definitions: [] };
    const absolute = differenceHundredths(comparison.garmentCm, comparison.bodyCm);
    const magnitude = absolute < BigInt(0) ? -absolute : absolute;
    current.hundredths += magnitude;
    current.definitions.push(comparison.bodyDefinition);
    groups.set(key, current);
  }
  const ranked = [...groups.values()];
  if (ranked.length < 2) return null;
  const signature = ranked[0]?.definitions.slice().sort().join(",");
  if (!signature || ranked.some((group) => group.definitions.slice().sort().join(",") !== signature)) return null;
  const closest = ranked.reduce((best, group) => (group.hundredths < best.hundredths ? group : best));
  return {
    size: closest.size,
    absoluteDifferenceCm: signedCentimetres(closest.hundredths),
    message: "This size has the smallest sum of absolute differences on the compared dimensions. It is not a size recommendation.",
  };
}

function sourcePhrase(source: string): string {
  if (source === "user_entered") return "entered by the profile owner";
  if (source === "tailor_recorded") return "recorded by a tailor";
  if (source === "imported") return "imported";
  if (source === "professionally_verified") return "professionally verified";
  return "recorded";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}
