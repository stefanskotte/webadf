import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askUntilAnswered } from './ask-listing';
import { PANE_ASK_MS, PANE_GIVE_UP_MS } from '@/lib/remote-limits';

type R = { listing: string } | { error: string };
const pending = { pending: 'Reading Work: from A500…' };

describe('askUntilAnswered (NET: volumes, spec 2026-10-30 §4.4)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks again every PANE_ASK_MS, fresh only the first time, until it lands', async () => {
    const ask = vi.fn<(path: string, fresh: boolean) => Promise<R | { pending: string }>>()
      .mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce({ listing: 'done' });
    const labels: string[] = [];
    const run = askUntilAnswered<R>('NET:/b/Work', { ask, fresh: true, wanted: () => true, onPending: (l) => labels.push(l), giveUp: () => ({ error: 'x' }) });
    await vi.advanceTimersByTimeAsync(2 * PANE_ASK_MS);
    await expect(run).resolves.toEqual({ listing: 'done' });
    expect(ask.mock.calls).toEqual([['NET:/b/Work', true], ['NET:/b/Work', false], ['NET:/b/Work', false]]);
    expect(labels).toEqual([pending.pending, pending.pending]);
  });

  it('stops without a word once it is no longer wanted (the pane went elsewhere, or unmounted)', async () => {
    let wanted = true;
    const ask = vi.fn(async (): Promise<R | { pending: string }> => pending);
    const onPending = vi.fn();
    const run = askUntilAnswered<R>('NET:/b', { ask, wanted: () => wanted, onPending, giveUp: () => ({ error: 'x' }) });
    await vi.advanceTimersByTimeAsync(PANE_ASK_MS);
    wanted = false;
    await vi.advanceTimersByTimeAsync(10 * PANE_ASK_MS);
    await expect(run).resolves.toBeNull();
    const asks = ask.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PANE_GIVE_UP_MS);
    expect(ask.mock.calls.length).toBe(asks);
    expect(asks).toBeLessThanOrEqual(3);
  });

  it('gives up after PANE_GIVE_UP_MS with the give-up answer, and asks no more', async () => {
    const ask = vi.fn(async (): Promise<R | { pending: string }> => pending);
    const run = askUntilAnswered<R>('NET:/b', { ask, wanted: () => true, onPending: () => {}, giveUp: () => ({ error: "A500 didn't answer — Refresh to try again" }) });
    await vi.advanceTimersByTimeAsync(PANE_GIVE_UP_MS - PANE_ASK_MS);
    expect(ask.mock.calls.length).toBe(PANE_GIVE_UP_MS / PANE_ASK_MS);
    await vi.advanceTimersByTimeAsync(PANE_ASK_MS);
    await expect(run).resolves.toEqual({ error: "A500 didn't answer — Refresh to try again" });
    const asks = ask.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * PANE_ASK_MS);
    expect(ask.mock.calls.length).toBe(asks);
  });
});
