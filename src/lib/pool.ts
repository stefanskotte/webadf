/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving input
 * order in the result.
 *
 * Exists because several call sites used to do `Promise.all(xs.map(fn))` over
 * a batch that can legitimately hold MAX_BATCH (500) entries: 500 simultaneous
 * ~880 KB uploads is ~440 MB in flight from one browser tab, and 500
 * simultaneous head()/presign calls from one serverless invocation is a
 * reliable way to trip the Blob service's rate limiter and 500 the whole
 * batch. Bounding it costs a little wall-clock and removes both failure modes.
 *
 * Rejections propagate (same semantics as Promise.all) — callers that want
 * per-item failure handling catch inside `fn`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error(`mapLimit: limit must be >= 1, got ${limit}`);
  const out = new Array<R>(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}
