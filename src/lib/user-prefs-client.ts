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

/**
 * Saves where only the LATEST choice counts -- a sort picker, where arrow
 * keys on a closed <select> fire a change per press.
 *
 * SERIALISED, never concurrent: aborting a request only cancels the browser's
 * side, and one already on the server could still commit after a newer one,
 * leaving the stored value behind what the picker shows. So at most one save
 * is in flight; choices made meanwhile replace each other as a single pending
 * one, sent when the in-flight save settles (skipped if it equals what was
 * just saved). A replaced or overtaken save resolves 'stale' (never throws);
 * only the newest decides what the picker does next (refresh, or say the save
 * failed).
 */
export function latestSaver() {
  type Waiter = { patch: PrefsPatch; resolve: (r: 'saved' | 'stale') => void; reject: (e: unknown) => void };
  let busy = false;
  let pending: Waiter | null = null;
  const same = (a: PrefsPatch, b: PrefsPatch) => JSON.stringify(a) === JSON.stringify(b);

  function send(w: Waiter) {
    busy = true;
    savePrefs(w.patch).then(
      () => settle(w, null),
      (err: unknown) => settle(w, err ?? new Error('Saving preferences failed')),
    );
  }

  function settle(w: Waiter, err: unknown) {
    const next = pending;
    pending = null;
    if (!next) {
      busy = false;
      if (err) w.reject(err); else w.resolve('saved');
      return;
    }
    w.resolve('stale');
    if (!err && same(next.patch, w.patch)) {
      busy = false;
      next.resolve('saved');
      return;
    }
    send(next);
  }

  return {
    save(patch: PrefsPatch): Promise<'saved' | 'stale'> {
      return new Promise((resolve, reject) => {
        const w: Waiter = { patch, resolve, reject };
        if (!busy) { send(w); return; }
        pending?.resolve('stale');
        pending = w;
      });
    },
  };
}
