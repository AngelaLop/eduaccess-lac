/**
 * In-memory per-IP rate limiter.
 *
 * Why in-memory and not Vercel KV / Upstash:
 *   - Free, zero config, no external dependency.
 *   - State survives within one serverless instance — enough to block a
 *     loop from a single IP. A determined attacker could still burst by
 *     hitting cold starts, but that's a tiny fraction of the threat.
 *   - On v4 we can swap this for @upstash/ratelimit if Vercel KV gets
 *     enabled; the consumer-side API stays the same.
 *
 * Sliding window: each IP has a list of timestamps in the last `windowMs`.
 * On every check we drop expired entries; if the count is at the limit
 * we return { allowed: false, retryAfterSec }, otherwise we append the
 * current timestamp and return { allowed: true }.
 *
 * Total memory: bounded by `maxIps`; oldest entries are evicted (FIFO).
 */

interface LimitResult {
  allowed: boolean;
  retryAfterSec: number; // 0 when allowed
  remaining: number;
}

interface LimiterOptions {
  windowMs: number;
  max: number;
  maxIps?: number;
}

export function createRateLimiter(opts: LimiterOptions) {
  const windowMs = opts.windowMs;
  const max = opts.max;
  const maxIps = opts.maxIps ?? 10_000;
  const hits = new Map<string, number[]>();

  return function check(ip: string): LimitResult {
    const now = Date.now();
    const cutoff = now - windowMs;
    const existing = hits.get(ip);
    const recent = existing ? existing.filter((t) => t > cutoff) : [];

    if (recent.length >= max) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      // Keep the truncated list so we don't lose state on rejection.
      hits.set(ip, recent);
      return { allowed: false, retryAfterSec, remaining: 0 };
    }

    recent.push(now);
    hits.set(ip, recent);

    // Bound memory: if we're over capacity, drop the smallest first
    // (a rough FIFO; sufficient for class-project scale).
    if (hits.size > maxIps) {
      const firstKey = hits.keys().next().value;
      if (firstKey !== undefined) hits.delete(firstKey);
    }

    return { allowed: true, retryAfterSec: 0, remaining: max - recent.length };
  };
}

/**
 * Best-effort client IP from a NextRequest. Vercel sets x-forwarded-for;
 * locally it may be missing, in which case we fall back to a constant
 * key so dev still works.
 */
export function ipFromHeaders(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    // x-forwarded-for is a comma-list; the leftmost entry is the original client.
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  return 'local';
}
