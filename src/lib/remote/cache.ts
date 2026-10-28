// The recipient's listing cache (spec §4.2: "Listings are cached per remote library for 60 s"). SERVER ONLY.
// In memory, per server instance: a cold instance simply asks the owner again. Only successful answers are kept --
// a failure ({ ok: false }) must be retried at the next visit, never served from here. At most MAX_ENTRIES; the
// oldest insertion goes first.

const MAX_ENTRIES = 500;

const entries = new Map<string, { value: unknown; expires: number }>();

function isFailure(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
}

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return hit.value as T;
    entries.delete(key);
  }
  const value = await load();
  if (!isFailure(value)) {
    entries.delete(key);
    entries.set(key, { value, expires: Date.now() + ttlMs });
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value as string;
      entries.delete(oldest);
    }
  }
  return value;
}

/** Forget every entry whose key starts with `prefix` (a removed or ended library). */
export function forgetCached(prefix: string): void {
  for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
}

/** Tests only. */
export function clearCacheForTests(): void {
  entries.clear();
}

/** Tests only. */
export function cacheSizeForTests(): number {
  return entries.size;
}
