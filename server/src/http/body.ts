import { invalid } from "../errors";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("invalid_body", "Expected an object.");
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, code: string, message: string): string {
  if (typeof value !== "string") throw invalid(code, message);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("invalid_body", "Expected a string.");
  return value;
}

export function requireUuid(value: string, code = "not_found"): string {
  if (!uuidPattern.test(value)) throw invalid(code, code === "not_found" ? "Not found." : "Organization was not found.");
  return value;
}

export function optionalSlug(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !slugPattern.test(value)) {
    throw invalid("invalid_filter", "Filter is not valid.");
  }
  return value;
}

export function optionalVisibility(value: unknown): "private" | "public" | undefined {
  if (value === undefined) return undefined;
  if (value !== "private" && value !== "public") {
    throw invalid("invalid_visibility", "Visibility must be private or public.");
  }
  return value;
}

export function pageLimit(value: unknown): number {
  return boundedInteger(value, 20, 1, 50);
}

export function pageOffset(value: unknown): number {
  return boundedInteger(value, 0, 0, 10000);
}

export function termList(value: unknown): { kind: string; slug: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid("invalid_body", "Expected a list of terms.");
  return value.map((item) => {
    const record = objectBody(item);
    if (typeof record.kind !== "string" || typeof record.slug !== "string") {
      throw invalid("invalid_body", "Each term needs a kind and a slug.");
    }
    return { kind: record.kind, slug: record.slug };
  });
}

export function sizeList(value: unknown): { system: string; label: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid("invalid_body", "Expected a list of sizes.");
  return value.map((item) => {
    const record = objectBody(item);
    if (typeof record.system !== "string" || typeof record.label !== "string") {
      throw invalid("invalid_body", "Each size needs a system and a label.");
    }
    return { system: record.system, label: record.label };
  });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw invalid("invalid_page", "Page is not valid.");
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw invalid("invalid_page", "Page is not valid.");
  return parsed;
}
