import type { PrefsPatch, UserPrefs } from '@/lib/user-prefs-schema';

/**
 * Save part of the signed-in user's preferences from the browser
 * (PATCH /api/me/prefs). Resolves to the full preferences after the save;
 * throws when the server refused it, so a caller can say so instead of
 * leaving a picker showing a choice that was never stored.
 */
export async function savePrefs(patch: PrefsPatch, signal?: AbortSignal): Promise<UserPrefs> {
  const res = await fetch('/api/me/prefs', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
    signal,
  });
  if (!res.ok) throw new Error(`Saving preferences failed (${res.status})`);
  return res.json() as Promise<UserPrefs>;
}

/**
 * Saves where only the LATEST choice counts -- a sort picker, where arrow
 * keys on a closed <select> fire a change per press. Each save aborts the one
 * still in flight and is numbered; a save overtaken by a newer one resolves
 * 'stale' (never throws), so only the newest decides what the picker does
 * next (refresh, or say the save failed).
 */
export function latestSaver() {
  let seq = 0;
  let inFlight: AbortController | null = null;
  return {
    async save(patch: PrefsPatch): Promise<'saved' | 'stale'> {
      const mine = ++seq;
      inFlight?.abort();
      const ctl = new AbortController();
      inFlight = ctl;
      try {
        await savePrefs(patch, ctl.signal);
      } catch (err) {
        if (mine !== seq) return 'stale';
        throw err;
      } finally {
        if (inFlight === ctl) inFlight = null;
      }
      return mine === seq ? 'saved' : 'stale';
    },
  };
}
