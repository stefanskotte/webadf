// Rate limit for upload from a URL.
//
// IN MEMORY, per function instance, on purpose for now. The app has no
// general-purpose limiter (step-up-throttle.ts is a lockout table for one
// purpose), and a DB-backed one needs a new table -- a schema change that has
// to be applied to production before the route could work at all. What this
// limits is already narrow: every request is authenticated, org-scoped, and
// bounded to one public URL, 20 MiB, 3 redirects and 25 s. The limiter's job
// is to stop one session from turning that into a loop; per-instance counting
// does that for the common case (Fluid compute reuses warm instances), and
// cannot do it across a cold-start fan-out. Recorded as a follow-up in the
// W3 report: move to a DB counter if this ever sees real abuse.
//
// Counted on ATTEMPTS, refused or not, so probing addresses costs the same as
// fetching files.

export const URL_FETCH_RATE = {
  perUserPerMinute: 6,
  perUserPerHour: 60,
  perOrgPerHour: 120,
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Records an attempt under every key if ALL of them have room; otherwise
   * records nothing and returns the ms until the tightest one frees up.
   */
  take(rules: { key: string; limit: number; windowMs: number }[]): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    let wait = 0;
    for (const r of rules) {
      const list = (this.hits.get(r.key) ?? []).filter((at) => t - at < r.windowMs);
      this.hits.set(r.key, list);
      if (list.length >= r.limit) wait = Math.max(wait, list[list.length - r.limit] + r.windowMs - t);
    }
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    for (const r of rules) this.hits.get(r.key)!.push(t);
    // Keep the map from growing without bound on a long-lived instance.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.length === 0 || t - v[v.length - 1] > HOUR) this.hits.delete(k);
    }
    return { ok: true };
  }
}

const limiter = new SlidingWindowLimiter();

export function takeUrlFetch(
  userId: string, orgId: string, l: SlidingWindowLimiter = limiter,
): { ok: true } | { ok: false; retryAfterMs: number } {
  return l.take([
    { key: `u-min:${userId}`, limit: URL_FETCH_RATE.perUserPerMinute, windowMs: MINUTE },
    { key: `u-hr:${userId}`, limit: URL_FETCH_RATE.perUserPerHour, windowMs: HOUR },
    { key: `o-hr:${orgId}`, limit: URL_FETCH_RATE.perOrgPerHour, windowMs: HOUR },
  ]);
}
