// The re-ask loop of a NET: listing the Amiga has not answered yet (NET: volumes, spec 2026-10-30 §4.4): the manager's
// panes and the Copy to… picker. CLIENT-SAFE: no DOM, no fetch of its own (`ask` is the caller's).
import { PANE_ASK_MS } from '@/lib/remote-limits';
import { nextAsk } from './net-rules';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `ask` until it answers something other than `{ pending }`: every PANE_ASK_MS, with `fresh` on the first ask only (the
 * request is on its way after that), until it lands, is refused, or PANE_GIVE_UP_MS pass (then `giveUp()`'s answer).
 * `onPending` hears each label; once `wanted()` is false (the pane went elsewhere, or the manager unmounted) it stops
 * at once with null, without a word, and asks no more.
 */
export async function askUntilAnswered<R extends object>(path: string, o: {
  ask(path: string, fresh: boolean): Promise<R | { pending: string }>; fresh?: boolean;
  wanted(): boolean; onPending(label: string): void; giveUp(): R;
}): Promise<R | null> {
  const started = Date.now();
  let r = await o.ask(path, !!o.fresh);
  while ('pending' in r) {
    if (!o.wanted()) return null;
    o.onPending(r.pending);
    await sleep(PANE_ASK_MS);
    if (!o.wanted()) return null;
    if (nextAsk(started, Date.now()) === 'give-up') return o.giveUp();
    r = await o.ask(path, false);
  }
  return o.wanted() ? r : null;
}
