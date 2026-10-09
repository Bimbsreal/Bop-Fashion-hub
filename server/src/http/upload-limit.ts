import { DomainError } from "../errors";

export function createUploadLimiter(maxPerMinute: number) {
  return createRateLimiter(maxPerMinute, "Too many uploads. Try again shortly.");
}

export function createRateLimiter(maxPerMinute: number, message: string) {
  const hits = new Map<string, number[]>();
  return (userId: string) => {
    const now = Date.now();
    const recent = (hits.get(userId) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= maxPerMinute) {
      throw new DomainError("rate_limited", message);
    }
    recent.push(now);
    hits.set(userId, recent);
  };
}
