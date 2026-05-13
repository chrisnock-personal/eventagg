// ─── Simple in-memory TTL cache ───────────────────────────────────────────────
// No external dependencies. Single-node safe. Entries expire after ttlMs.
// Suitable for stats/aggregate queries where 30–120s stale data is acceptable.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private cleanupInterval: NodeJS.Timeout;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
    // Sweep expired entries every 2× the TTL
    this.cleanupInterval = setInterval(() => this.sweep(), ttlMs * 2);
    this.cleanupInterval.unref(); // Don't keep process alive
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidateAll(): void {
    this.store.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  get size(): number {
    return this.store.size;
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}

// ─── Shared caches ────────────────────────────────────────────────────────────
export const statsCache       = new TtlCache(60_000);   // 60s TTL
export const performanceCache = new TtlCache(30_000);   // 30s TTL

// Build a deterministic cache key from a filters object
export function cacheKey(prefix: string, filters: Record<string, unknown>): string {
  const sorted = Object.keys(filters)
    .sort()
    .filter(k => filters[k] !== undefined && filters[k] !== null && filters[k] !== "")
    .map(k => `${k}=${filters[k]}`)
    .join("&");
  return `${prefix}:${sorted || "all"}`;
}
