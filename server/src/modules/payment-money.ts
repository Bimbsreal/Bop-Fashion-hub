const exponents: Record<string, number> = {
  BHD: 3,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  AUD: 2,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  GHS: 2,
  KES: 2,
  NGN: 2,
  USD: 2,
  ZAR: 2,
};

export function currencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

export function minorExponent(currency: string): number | null {
  if (!currencyCode(currency)) return null;
  const exponent = exponents[currency];
  return exponent === undefined ? null : exponent;
}

export function wholeMinor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}
