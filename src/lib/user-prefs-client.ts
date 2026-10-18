import type { PrefsPatch, UserPrefs } from '@/lib/user-prefs-schema';

/**
 * Save part of the signed-in user's preferences from the browser
 * (PATCH /api/me/prefs). Resolves to the full preferences after the save;
 * throws when the server refused it, so a caller can say so instead of
 * leaving a picker showing a choice that was never stored.
 */
export async function savePrefs(patch: PrefsPatch): Promise<UserPrefs> {
  const res = await fetch('/api/me/prefs', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Saving preferences failed (${res.status})`);
  return res.json() as Promise<UserPrefs>;
}
