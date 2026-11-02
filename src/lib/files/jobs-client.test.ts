import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJobsStore, IDLE_POLL_MS, nextDelay, OFFLINE_POLL_MS, OPEN_KEY, POLL_MS, SEEN_KEY, SEEN_MAX, TRACK_MS, type JobsDeps } from './jobs-client';
import { timeLeft, WINDOW_MS, type JobView } from './job-view';

const job = (o: Partial<JobView> = {}): JobView => ({
  id: 'j1', kind: 'copy', direction: 'to', board: 'A500', from: null, place: 'Work:Tools', writeKind: null,
  total: 2, done: 0, failed: [], waiting: 2, skipped: 0, writes: [], offline: null, arrived: [],
  cancelled: 0, cancel: null, bytes: { total: 1000, done: 0 }, current: null, running: true,
  startedAt: '2026-11-01T10:00:00.000Z', finishedAt: null, ...o,
});
const finished = (o: Partial<JobView> = {}) => job({ running: false, waiting: 0, done: 2, finishedAt: '2026-11-01T10:00:05.000Z', ...o });
type Answer = JobView[] | 'signed-out' | null;

function harness(answers: Answer[], o: Partial<Pick<JobsDeps, 'visible' | 'storage' | 'loadOne'>> = {}) {
  let k = 0;
  const loadOne = vi.fn(o.loadOne ?? (async () => null));
  const load = vi.fn(async () => {
    const a = answers[Math.min(k++, answers.length - 1)];
    return a === null || a === 'signed-out' ? a : { jobs: a };
  });
  const store = createJobsStore({
    load, loadOne, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    visible: o.visible ?? (() => true), storage: o.storage ?? (() => null),
  });
  return { store, load, loadOne };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('nextDelay (spec §3)', () => {
  it('2 s while a job runs, 15 s while every running job waits on an offline board, none otherwise', () => {
    const on = { tracking: false, visible: true, failed: false };
    expect(nextDelay([job()], on)).toBe(POLL_MS);
    expect(nextDelay([job({ offline: 'A500' })], on)).toBe(OFFLINE_POLL_MS);
    expect(nextDelay([job({ offline: 'A500' }), job({ id: 'j2' })], on)).toBe(POLL_MS);
    expect(nextDelay([finished()], on)).toBe(IDLE_POLL_MS);
    expect(nextDelay([], on)).toBe(IDLE_POLL_MS);
    expect(nextDelay([], { ...on, tracking: true })).toBe(POLL_MS);
    expect(nextDelay([job()], { ...on, visible: false })).toBeNull();
    expect(nextDelay([], { ...on, failed: true })).toBe(OFFLINE_POLL_MS);
  });
});

describe('createJobsStore polling', () => {
  it('IDLE_POLL_MS is 60 s', () => { expect(IDLE_POLL_MS).toBe(60_000); });
  it('nothing runs: a look every 60 s while visible, none in between', async () => {
    const { store, load } = harness([[]]);
    store.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);
    store.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('a hidden idle page asks nothing; shown again it asks at once, then every 60 s', async () => {
    let vis = true;
    const { store, load } = harness([[]], { visible: () => vis });
    store.start();
    await flush();
    vis = false; store.onVisibility();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(load).toHaveBeenCalledTimes(1);
    vis = true; store.onVisibility();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('a job tracked during the idle wait does not leave a second poll behind', async () => {
    const { store, load } = harness([[], [job()], [job()], [finished()]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    store.track('j1');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(load).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(5);
  });
  it('a running job: every 2 s, and quiet once it finished', async () => {
    const { store, load } = harness([[job()], [job()], [finished()]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('the board offline: every 15 s', async () => {
    const { store, load } = harness([[job({ offline: 'A500' })]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  // Review Focus 5: hidden, then shown.
  it('a hidden tab asks nothing; shown again it asks at once', async () => {
    let shown = true;
    const { store, load } = harness([[job()]], { visible: () => shown });
    store.start();
    await flush();
    shown = false;
    store.onVisibility();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(1);
    shown = true;
    store.onVisibility();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('track: a job started here is asked for at once, every 2 s until it shows, at most 10 s', async () => {
    const { store, load } = harness([[]]);
    store.start();
    await flush();
    store.track('j9');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TRACK_MS + 20_000);
    expect(load).toHaveBeenCalledTimes(7);
  });
  it('track stops once the job shows', async () => {
    const { store, load } = harness([[], [finished({ id: 'j9' })]]);
    store.start();
    await flush();
    store.track('j9');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('a failed load is tried again after 15 s', async () => {
    const { store, load } = harness([null, [job()]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.getState().jobs).toHaveLength(1);
  });
  it('a load that rejects is tried again after 15 s, with no unhandled rejection', async () => {
    let k = 0;
    const load = vi.fn(async () => { if (k++ === 0) throw new Error('network'); return { jobs: [job()] }; });
    const store = createJobsStore({ load, loadOne: async () => null, now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>), visible: () => true, storage: () => null });
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(OFFLINE_POLL_MS - 1_000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.getState().jobs).toHaveLength(1);
  });
  it('signed out: it stops and says so', async () => {
    const { store, load } = harness(['signed-out']);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getState().signedOut).toBe(true);
  });
});

describe('createJobsStore state', () => {
  it('a watched job that finished and left the list while the tab was hidden is fetched once and handed over', async () => {
    let shown = true;
    const done = finished({ arrived: ['STASH:/In/a', 'STASH:/In/b'] });
    const { store, loadOne } = harness([[job()], []], { visible: () => shown, loadOne: async () => done });
    const heard: JobView[] = [];
    store.watch('j1', (j) => heard.push(j));
    store.start();
    await flush();
    shown = false;
    store.onVisibility();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    shown = true;
    store.onVisibility();
    await flush();
    expect(loadOne).toHaveBeenCalledTimes(1);
    expect(loadOne).toHaveBeenCalledWith('j1');
    expect(heard.map((j) => j.running)).toEqual([true, false]);
    expect(heard[1]).toMatchObject({ done: 2, arrived: ['STASH:/In/a', 'STASH:/In/b'] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loadOne).toHaveBeenCalledTimes(1);
  });
  it('a watched job never listed within TRACK_MS is fetched once', async () => {
    const { store, loadOne } = harness([[]], { loadOne: async () => finished({ id: 'j9' }) });
    const heard: boolean[] = [];
    store.watch('j9', (j) => heard.push(j.running));
    store.track('j9');
    store.start();
    await vi.advanceTimersByTimeAsync(TRACK_MS + 5_000);
    expect(loadOne).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([false]);
  });
  it('a one-off ask that fails is tried again every 15 s (5 times at most); a job the server no longer has is let go', async () => {
    let calls = 0;
    const done = finished({ id: 'j9' });
    const { store, loadOne } = harness([[]], { loadOne: async () => (++calls < 3 ? null : done) });
    const heard: boolean[] = [];
    store.watch('j9', (j) => heard.push(j.running));
    store.track('j9');
    store.start();
    await vi.advanceTimersByTimeAsync(TRACK_MS + 5_000);
    expect(loadOne).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * OFFLINE_POLL_MS);
    expect(loadOne).toHaveBeenCalledTimes(3);
    expect(heard).toEqual([false]);
    const gone = harness([[]], { loadOne: async () => 'gone' as const });
    gone.store.watch('j8', () => { throw new Error('never heard'); });
    gone.store.track('j8');
    gone.store.start();
    await vi.advanceTimersByTimeAsync(TRACK_MS + 5 * OFFLINE_POLL_MS);
    expect(gone.loadOne).toHaveBeenCalledTimes(1);
    const failing = harness([[]], { loadOne: async () => null });
    failing.store.watch('j7', () => {});
    failing.store.track('j7');
    failing.store.start();
    await vi.advanceTimersByTimeAsync(TRACK_MS + 10 * OFFLINE_POLL_MS);
    expect(failing.loadOne).toHaveBeenCalledTimes(5);
  });
  it('a watched job still listed is never fetched on its own', async () => {
    const { store, loadOne } = harness([[job()], [job()], [finished()]]);
    store.watch('j1', () => {});
    store.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loadOne).not.toHaveBeenCalled();
  });
  it('watch hears each answer with its job; unwatched, nothing more', async () => {
    const { store } = harness([[job()], [job({ done: 1, waiting: 1 })], [finished()]]);
    const heard: number[] = [];
    const stop = store.watch('j1', (j) => heard.push(j.done));
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(heard).toEqual([0, 1]);
  });
  it('finishedSeenAt: when it was first seen finished, kept after', async () => {
    const { store } = harness([[finished()]]);
    store.start();
    await flush();
    const at = store.getState().finishedSeenAt.j1;
    expect(at).toBe(Date.now());
    vi.setSystemTime(Date.now() + 5_000);
    store.poke();
    await flush();
    expect(store.getState().finishedSeenAt.j1).toBe(at);
  });
  it('samples: a running job\'s bytes, the last 30 s only', async () => {
    const answers: Answer[] = Array.from({ length: 25 }, (_, k) => [job({ bytes: { total: 100_000, done: k * 1000 } })]);
    const { store } = harness(answers);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(40_000);
    const s = store.getState().samples.j1;
    expect(s[s.length - 1].done).toBe(20_000);
    expect(s.every((x) => x.at >= Date.now() - 30_000)).toBe(true);
  });
  // Task 1 review: timeLeft's warm-up must not anchor on samples older than the window after a stall.
  it('samples: a stall longer than the window drops the old ones, so no estimate until warm-up passes again', async () => {
    let shown = true;
    const answers: Answer[] = [[job({ bytes: { total: 100_000, done: 1000 } })], [job({ bytes: { total: 100_000, done: 50_000 } })], [job({ bytes: { total: 100_000, done: 60_000 } })]];
    const { store } = harness(answers, { visible: () => shown });
    store.start();
    await flush();
    shown = false;
    store.onVisibility();
    await vi.advanceTimersByTimeAsync(WINDOW_MS + 30_000);
    shown = true;
    store.onVisibility();
    await flush();
    const s = store.getState().samples.j1;
    expect(s).toHaveLength(1);
    expect(s[0].done).toBe(50_000);
    const j = job({ bytes: { total: 100_000, done: 50_000 } });
    expect(timeLeft(s, j, Date.now())).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(timeLeft(store.getState().samples.j1, job({ bytes: { total: 100_000, done: 60_000 } }), Date.now())).toBeNull();
  });
  it('announces once a job this page saw running finishes, with its result', async () => {
    const { store } = harness([[job()], [finished()]]);
    store.start();
    await flush();
    expect(store.getState().announce).toBe('');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getState().announce).toBe('Copied 2 to A500');
  });
  it('two identical results are each announced: the live region text differs, to the eye it does not', async () => {
    const { store } = harness([[job({ id: 'a' })], [finished({ id: 'a' })], [finished({ id: 'a' }), job({ id: 'b' })], [finished({ id: 'a' }), finished({ id: 'b' })]]);
    store.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    const first = store.getState().announce;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const second = store.getState().announce;
    expect(first).not.toBe(second);
    expect(first.replace(/\u00a0/g, '')).toBe('Copied 2 to A500');
    expect(second.replace(/\u00a0/g, '')).toBe('Copied 2 to A500');
  });
  it('a job already finished when the page loads is not announced', async () => {
    const { store } = harness([[finished()]]);
    store.start();
    await flush();
    expect(store.getState().announce).toBe('');
  });
  it('fadeFinished: a clean finish is put away 6 s after it was first seen; a failure stays', async () => {
    const { store } = harness([[finished(), finished({ id: 'j2', failed: [{ name: 'a', reason: 'r' }] })]]);
    store.start();
    await flush();
    store.fadeFinished(Date.now() + 5_000);
    expect(store.getState().seen).toEqual([]);
    store.fadeFinished(Date.now() + 6_000);
    expect(store.getState().seen).toEqual(['j1']);
  });
});

describe('remembered per browser', () => {
  function memory() {
    const m = new Map<string, string>();
    return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } } };
  }
  it('open/closed and the cards put away survive a new store', async () => {
    const { m, s } = memory();
    const a = harness([[]], { storage: () => s }).store;
    a.start();
    a.setOpen(false);
    a.dismiss('j1');
    expect(m.get(OPEN_KEY)).toBe('0');
    expect(JSON.parse(m.get(SEEN_KEY)!)).toEqual(['j1']);
    const b = harness([[]], { storage: () => s }).store;
    b.start();
    expect(b.getState()).toMatchObject({ open: false, seen: ['j1'] });
  });
  it('keeps the last 50 put away', () => {
    const { s } = memory();
    const a = harness([[]], { storage: () => s }).store;
    for (let k = 0; k < SEEN_MAX + 5; k++) a.dismiss(`j${k}`);
    expect(a.getState().seen).toHaveLength(SEEN_MAX);
    expect(a.getState().seen[0]).toBe('j5');
  });
  it('a storage accessor that throws changes nothing else: it still polls, and dismiss/setOpen still change state', async () => {
    const { store, load } = harness([[job()]], { storage: () => { throw new Error('blocked'); } });
    store.start();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(() => { store.setOpen(false); store.dismiss('j1'); }).not.toThrow();
    expect(store.getState()).toMatchObject({ open: false, seen: ['j1'] });
  });
  // Review Focus 5: storage that throws (a private window).
  it('storage that throws changes nothing else', async () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const { store } = harness([[job()]], { storage: () => bad });
    store.start();
    await flush();
    expect(store.getState()).toMatchObject({ open: true, seen: [] });
    store.setOpen(false);
    store.dismiss('j1');
    expect(store.getState()).toMatchObject({ open: false, seen: ['j1'] });
    expect(store.getState().jobs).toHaveLength(1);
  });
});
