// src/lib/files/jobs-client.ts
// The progress panel's store (spec 2026-11-01-progress-panel §3): the org's jobs as GET /api/files/jobs answers them,
// asked on load, then, while the page is visible: every 2 s while a job runs, every 15 s while every running job waits
// on a board that is offline, every 60 s while nothing runs. A hidden tab asks nothing. Files tells it about a job it
// just started (track) and hears each answer for it (watch). The server lists a finished job for 2 minutes only; a card
// with a failure or a cancel stays here until it is closed (a reload forgets it). The open/closed choice and the cards
// already put away are remembered per browser, a convenience: storage that throws or is empty changes nothing else.
// CLIENT-SAFE.
import { FADE_MS, isClean, QUEUE_JOB, resultWords, WINDOW_MS, type JobView, type Sample } from './job-view';

export const POLL_MS = 2_000;
export const OFFLINE_POLL_MS = 15_000;
/** A visible page with nothing running looks this often, for a job started elsewhere (a hidden tab asks nothing). */
export const IDLE_POLL_MS = 60_000;
/** A job this tab just started is looked for this long before the store stops asking for it. */
export const TRACK_MS = 10_000;
/** How many times a failed one-off ask for a watched job is tried (OFFLINE_POLL_MS apart) before it is let go. */
export const ONE_TRIES = 5;
export const OPEN_KEY = 'webadf:transfers-open';
export const SEEN_KEY = 'webadf:transfers-seen';
export const SEEN_MAX = 50;

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
export type JobsAnswer = { jobs: JobView[] };
export type JobsDeps = {
  /** One answer; 'signed-out' when the session is gone; null when there was none (network, 5xx). */
  load(): Promise<JobsAnswer | 'signed-out' | null>;
  /**
   * One job on its own (GET /api/files/net/fetch/<id>), null when there is none: asked once for a watched job the list
   * no longer holds (it finished more than 2 minutes ago, while the tab was hidden) or never held within TRACK_MS.
   */
  /** One job by its id: the job; 'gone' when the server no longer has it (404); null when the ask failed. */
  loadOne(id: string): Promise<JobView | 'gone' | null>;
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
  return running.length ? OFFLINE_POLL_MS : IDLE_POLL_MS;
}

/**
 * The live region's next text. A region announces only when its text changes, so the same words twice would be heard
 * once: a trailing U+00A0 is toggled then. It is in the live region alone (sr-only); no card shows it.
 */
export function announced(previous: string, words: string): string {
  return previous === words ? `${words}\u00a0` : words;
}

export function createJobsStore(deps: JobsDeps) {
  let state: JobsState = { jobs: [], samples: {}, finishedSeenAt: {}, open: true, seen: [], announce: '', signedOut: false };
  const listeners = new Set<() => void>();
  const watchers = new Map<string, Set<(j: JobView) => void>>();
  const tracked = new Map<string, number>();
  /** Each watched job: when it was first watched, and whether an answer has held it. */
  const watched = new Map<string, { since: number; listed: boolean }>();
  const fetching = new Set<string>();
  /** Jobs seen running that an answer let go with no watcher: asked for once, so a failure still gets its card. */
  const lost = new Set<string>();
  /** Failed one-off asks per job, so a flaky network is tried again (ONE_TRIES at most) but never forever. */
  const oneFails = new Map<string, number>();
  let timer: unknown = null;
  let inFlight = false;
  let again = false;
  let stopped = true;
  let failed = false;

  const set = (next: Partial<JobsState>) => { state = { ...state, ...next }; for (const l of listeners) l(); };
  /** Reading window.localStorage itself can throw (blocked site data): then nothing is remembered. */
  const storage = () => { try { return deps.storage(); } catch { return null; } };
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
    const wasRunning = state.signedOut ? [] : state.jobs.filter((j) => j.running);
    const samples: Record<string, Sample[]> = {};
    const finishedSeenAt: Record<string, number> = {};
    const words: string[] = [];
    for (const j of jobs) {
      if (j.running && j.bytes) {
        samples[j.id] = [...(state.samples[j.id] ?? []), { at: now, done: j.bytes.done, ended: j.total - j.waiting }].filter((s) => s.at >= now - WINDOW_MS);
      }
      if (!j.running) {
        finishedSeenAt[j.id] = state.finishedSeenAt[j.id] ?? now;
        if (state.jobs.some((x) => x.id === j.id && x.running)) words.push(resultWords(j));
      }
    }
    const announce = words.length ? announced(state.announce, words.join('. ')) : state.announce;
    // A card that must stay until closed, which the answer let go (the server lists a finished job for 2 minutes). Past a
    // signed-out answer none: this answer may be another account's. Kept out of `jobs`, what watchers below hear.
    // A board's Queue card takes a new id with each newest row: one that started no later already holds this one's rows.
    const queueOf = (j: JobView) => (j.id.startsWith(QUEUE_JOB) ? j.id.slice(0, j.id.lastIndexOf(':')) : null);
    const heldByNewer = (j: JobView) => queueOf(j) !== null && jobs.some((x) => queueOf(x) === queueOf(j) && x.startedAt <= j.startedAt);
    const kept = state.signedOut ? [] : state.jobs.filter((j) => !j.running && !isClean(j) && !state.seen.includes(j.id) && !jobs.some((x) => x.id === j.id) && !heldByNewer(j));
    for (const j of kept) finishedSeenAt[j.id] = state.finishedSeenAt[j.id] ?? now;
    // In the server's order (jobs.ts): the panel shows them newest first.
    const shown = kept.length ? [...jobs, ...kept].sort((x, y) => y.startedAt.localeCompare(x.startedAt) || x.id.localeCompare(y.id)) : jobs;
    set({ jobs: shown, samples, finishedSeenAt, announce, signedOut: false });
    for (const j of jobs) for (const w of [...(watchers.get(j.id) ?? [])]) w(j);
    // A watched job the list let go unseen (it finished while the tab was hidden, more than 2 minutes ago) or never
    // held: asked for on its own, once, so its watchers still hear how it ended (a Download, the panes read again).
    for (const [id, w] of watched) {
      if (jobs.some((j) => j.id === id)) { w.listed = true; continue; }
      if ((w.listed || now - w.since >= TRACK_MS) && !fetching.has(id)) void fetchOne(id);
    }
    // A job that ran, gone from the answer (it finished over 2 minutes ago, while the tab was hidden). A board's Queue card
    // has no job of its own to ask for: its rows answer under a new id.
    for (const j of wasRunning) {
      if (jobs.some((x) => x.id === j.id) || j.id.startsWith(QUEUE_JOB) || fetching.has(j.id)) continue;
      if (!watched.has(j.id)) lost.add(j.id);
      void fetchOne(j.id);
    }
  }

  /** A job asked for on its own that failed or was cancelled: its card, as if the list had still held it. */
  function keepCard(j: JobView) {
    if (j.running || isClean(j) || state.signedOut || state.seen.includes(j.id) || state.jobs.some((x) => x.id === j.id)) return;
    const jobs = [...state.jobs, j].sort((x, y) => y.startedAt.localeCompare(x.startedAt) || x.id.localeCompare(y.id));
    set({ jobs, finishedSeenAt: { ...state.finishedSeenAt, [j.id]: state.finishedSeenAt[j.id] ?? deps.now() }, announce: announced(state.announce, resultWords(j)) });
  }

  async function fetchOne(id: string) {
    fetching.add(id);
    let a: JobView | 'gone' | null = null;
    try { a = await deps.loadOne(id); } catch { a = null; }
    fetching.delete(id);
    if (stopped) return;
    if (a === null) {
      // The ask failed (network, 5xx): tried again on its own timer -- with nothing running the store asks nothing.
      const n = (oneFails.get(id) ?? 0) + 1;
      oneFails.set(id, n);
      const wanted = () => watched.has(id) || lost.has(id);
      if (n < ONE_TRIES && wanted()) { deps.setTimer(() => { if (!stopped && !fetching.has(id) && wanted()) void fetchOne(id); }, OFFLINE_POLL_MS); return; }
    }
    oneFails.delete(id);
    lost.delete(id);
    const j = a === 'gone' ? null : a;
    if (j) { keepCard(j); for (const w of [...(watchers.get(id) ?? [])]) w(j); }
    // Still running (a list that missed it): watched as if just begun. Else it is forgotten: nothing more will come.
    const w = watched.get(id);
    if (j?.running && w) { w.since = deps.now(); w.listed = false; } else { watched.delete(id); watchers.delete(id); }
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
    } catch {
      failed = true;
    } finally {
      inFlight = false;
      if (again) { again = false; void tick(); } else schedule();
    }
  }

  function dismiss(id: string) {
    const seen = [...state.seen.filter((x) => x !== id), id].slice(-SEEN_MAX);
    save(storage(), SEEN_KEY, JSON.stringify(seen));
    set({ seen });
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start() {
      const s = storage();
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
      if (!watched.has(id)) watched.set(id, { since: deps.now(), listed: false });
      return () => { list.delete(fn); if (list.size === 0 && watchers.get(id) === list) { watchers.delete(id); watched.delete(id); } };
    },
    setOpen(open: boolean) { save(storage(), OPEN_KEY, open ? '1' : '0'); set({ open }); },
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
