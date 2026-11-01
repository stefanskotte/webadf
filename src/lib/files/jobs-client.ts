// src/lib/files/jobs-client.ts
// The progress panel's store (spec 2026-11-01-progress-panel §3): the org's jobs as GET /api/files/jobs answers them,
// asked once on load and then only while a job runs -- every 2 s while the page is visible, every 15 s while every
// running job waits on a board that is offline, never while the tab is hidden. Files tells it about a job it just
// started (track) and hears each answer for it (watch). The open/closed choice and the cards already put away are
// remembered per browser, a convenience: storage that throws or is empty changes nothing else. CLIENT-SAFE.
import { FADE_MS, isClean, resultWords, WINDOW_MS, type JobView, type Sample } from './job-view';

export const POLL_MS = 2_000;
export const OFFLINE_POLL_MS = 15_000;
/** A job this tab just started is looked for this long before the store stops asking for it. */
export const TRACK_MS = 10_000;
export const OPEN_KEY = 'webadf:transfers-open';
export const SEEN_KEY = 'webadf:transfers-seen';
export const SEEN_MAX = 50;

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
export type JobsAnswer = { jobs: JobView[] };
export type JobsDeps = {
  /** One answer; 'signed-out' when the session is gone; null when there was none (network, 5xx). */
  load(): Promise<JobsAnswer | 'signed-out' | null>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  visible(): boolean;
  storage(): KeyStore | null;
};
export type JobsState = {
  jobs: JobView[];
  samples: Record<string, Sample[]>;
  finishedSeenAt: Record<string, number>;
  open: boolean;
  /** Cards closed, or faded after a clean finish: not shown again in this browser. */
  seen: string[];
  /** The polite live region's words: the last job this page saw running that finished. */
  announce: string;
  signedOut: boolean;
};

export function readOpen(s: KeyStore | null): boolean {
  try { return s?.getItem(OPEN_KEY) !== '0'; } catch { return true; }
}
export function readSeen(s: KeyStore | null): string[] {
  try {
    const v: unknown = JSON.parse(s?.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-SEEN_MAX) : [];
  } catch { return []; }
}
function save(s: KeyStore | null, key: string, value: string) {
  try { s?.setItem(key, value); } catch { /* not remembered; this page still has it */ }
}

/** How long until the next ask, or null for none (spec §3). A failed ask is tried again after OFFLINE_POLL_MS. */
export function nextDelay(jobs: JobView[], o: { tracking: boolean; visible: boolean; failed: boolean }): number | null {
  if (!o.visible) return null;
  if (o.failed) return OFFLINE_POLL_MS;
  const running = jobs.filter((j) => j.running);
  if (o.tracking || running.some((j) => !j.offline)) return POLL_MS;
  return running.length ? OFFLINE_POLL_MS : null;
}

export function createJobsStore(deps: JobsDeps) {
  let state: JobsState = { jobs: [], samples: {}, finishedSeenAt: {}, open: true, seen: [], announce: '', signedOut: false };
  const listeners = new Set<() => void>();
  const watchers = new Map<string, Set<(j: JobView) => void>>();
  const tracked = new Map<string, number>();
  let timer: unknown = null;
  let inFlight = false;
  let again = false;
  let stopped = true;
  let failed = false;

  const set = (next: Partial<JobsState>) => { state = { ...state, ...next }; for (const l of listeners) l(); };
  const clear = () => { if (timer !== null) { deps.clearTimer(timer); timer = null; } };

  function schedule() {
    if (stopped || timer !== null || state.signedOut) return;
    const now = deps.now();
    for (const [id, until] of tracked) if (until <= now || state.jobs.some((j) => j.id === id)) tracked.delete(id);
    const ms = nextDelay(state.jobs, { tracking: tracked.size > 0, visible: deps.visible(), failed });
    if (ms !== null) timer = deps.setTimer(() => { timer = null; void tick(); }, ms);
  }

  function take(jobs: JobView[]) {
    const now = deps.now();
    const samples: Record<string, Sample[]> = {};
    const finishedSeenAt: Record<string, number> = {};
    let announce = state.announce;
    for (const j of jobs) {
      if (j.running && j.bytes) {
        samples[j.id] = [...(state.samples[j.id] ?? []), { at: now, done: j.bytes.done }].filter((s) => s.at >= now - WINDOW_MS);
      }
      if (!j.running) {
        finishedSeenAt[j.id] = state.finishedSeenAt[j.id] ?? now;
        if (state.jobs.some((x) => x.id === j.id && x.running)) announce = resultWords(j);
      }
    }
    set({ jobs, samples, finishedSeenAt, announce, signedOut: false });
    for (const j of jobs) for (const w of [...(watchers.get(j.id) ?? [])]) w(j);
  }

  async function tick() {
    if (stopped) return;
    if (inFlight) { again = true; return; }
    inFlight = true;
    try {
      const a = await deps.load();
      if (stopped) return;
      failed = a === null;
      if (a === 'signed-out') set({ signedOut: true });
      else if (a) take(a.jobs);
    } finally {
      inFlight = false;
      if (again) { again = false; void tick(); } else schedule();
    }
  }

  function dismiss(id: string) {
    const seen = [...state.seen.filter((x) => x !== id), id].slice(-SEEN_MAX);
    save(deps.storage(), SEEN_KEY, JSON.stringify(seen));
    set({ seen });
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start() {
      const s = deps.storage();
      set({ open: readOpen(s), seen: readSeen(s) });
      stopped = false;
      void tick();
    },
    stop() { stopped = true; clear(); },
    /** Ask now (after a Cancel), whatever the schedule. */
    poke() { clear(); void tick(); },
    /** The tab was hidden or shown: shown asks at once, hidden asks nothing until shown. */
    onVisibility() { clear(); if (deps.visible()) void tick(); },
    /** A job this tab just started: asked for now, and every POLL_MS until it shows (TRACK_MS at most). */
    track(id: string) { tracked.set(id, deps.now() + TRACK_MS); clear(); void tick(); },
    /** Hears every answer that holds job `id`, from the next one; the returned function stops it. */
    watch(id: string, fn: (j: JobView) => void) {
      const list = watchers.get(id) ?? new Set<(j: JobView) => void>();
      list.add(fn);
      watchers.set(id, list);
      return () => { list.delete(fn); if (list.size === 0) watchers.delete(id); };
    },
    setOpen(open: boolean) { save(deps.storage(), OPEN_KEY, open ? '1' : '0'); set({ open }); },
    dismiss,
    /** Puts away each clean finish seen finished FADE_MS ago or more (spec §3: it fades after 6 s). */
    fadeFinished(now: number) {
      for (const j of state.jobs) {
        const at = state.finishedSeenAt[j.id];
        if (!j.running && isClean(j) && at !== undefined && now - at >= FADE_MS && !state.seen.includes(j.id)) dismiss(j.id);
      }
    },
  };
}
export type JobsStore = ReturnType<typeof createJobsStore>;
