export type MeasureUnit = "cm" | "m" | "in";

const units = new Set<MeasureUnit>(["cm", "m", "in"]);
const zero = BigInt(0);
const one = BigInt(1);
const two = BigInt(2);
const ten = BigInt(10);
const inchFactor = BigInt(254);

export function isMeasureUnit(value: string): value is MeasureUnit {
  return units.has(value as MeasureUnit);
}

export function convertMeasurement(raw: string, unit: MeasureUnit): { enteredText: string; canonicalCm: string } {
  const enteredText = raw.trim();
  const scale = fractionScale(enteredText, unit);
  const minor = parseMinor(enteredText, scale);
  if (minor <= zero) {
    return { enteredText, canonicalCm: "0.00" };
  }
  const hundredths = toCentimetreHundredths(minor, scale, unit);
  return { enteredText, canonicalCm: formatMinor(hundredths, 2) };
}

export function displayCanonical(canonicalCm: string, unit: MeasureUnit): string {
  const hundredths = parseMinor(canonicalCm, 2);
  if (unit === "cm") return formatMinor(hundredths, 2);
  if (unit === "m") return formatMinor(divideHalfUp(hundredths, ten), 3);
  return formatMinor(divideHalfUp(hundredths * BigInt(100), inchFactor), 2);
}

export function centimetresToHundredths(value: string): bigint {
  return parseMinor(value, 2);
}

function fractionScale(text: string, unit: MeasureUnit): number {
  const maxFraction = unit === "m" ? 3 : 2;
  const match = /^(?:0|[1-9]\d{0,5})(?:\.(\d+))?$/.exec(text);
  if (!match) return -1;
  const fraction = match[1] ?? "";
  if (fraction.length > maxFraction) return -1;
  return fraction.length;
}

function parseMinor(text: string, scale: number): bigint {
  if (scale < 0) return BigInt(-1);
  const [whole, fraction = ""] = text.split(".");
  const digits = `${whole}${fraction.padEnd(scale, "0")}`;
  return BigInt(digits);
}

function toCentimetreHundredths(minor: bigint, scale: number, unit: MeasureUnit): bigint {
  if (unit === "cm") return minor * ten ** BigInt(2 - scale);
  if (unit === "m") return minor * ten ** BigInt(4 - scale);
  return divideHalfUp(minor * inchFactor, ten ** BigInt(scale));
}

function divideHalfUp(numerator: bigint, divisor: bigint): bigint {
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder * two >= divisor) return quotient + one;
  return quotient;
}

function formatMinor(minor: bigint, scale: number): string {
  const base = ten ** BigInt(scale);
  const whole = minor / base;
  const fraction = (minor % base).toString().padStart(scale, "0");
  return `${whole}.${fraction}`;
}

export function acceptedEntry(raw: string, unit: MeasureUnit): boolean {
  return fractionScale(raw.trim(), unit) >= 0;
}
