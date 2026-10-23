'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { SendTarget } from '@/lib/send-ui';
import type { UploadBoard } from '@/lib/amiga-uploads';
import {
  anyMoving, beginChange, endChange, idleClock, readIsCurrent, trackStalls, type LibRow, type ServerRow, type UpRow,
} from '@/lib/upload-staging';

// While anything waits, sends or arrives the list is read every 3 s (progress moves per 16 KB chunk); otherwise every 10 s.
const ACTIVE_MS = 3_000;
const IDLE_MS = 10_000;

type Seen = Parameters<typeof trackStalls>[0];
type Staging = {
  libRows: LibRow[];
  upRows: UpRow[];
  setLibRows: (fn: (rows: LibRow[]) => LibRow[]) => void;
  addUp: (row: UpRow) => void;
  patchUp: (key: string, patch: Partial<UpRow>) => void;
  /** Drops browser rows by key, and hides server rows by key until the next answer that still has them. */
  removeLocal: (keys: string[]) => void;
  serverRows: ServerRow[];
  /** The latest answer's send targets; null before the first good answer. */
  targets: SendTarget[] | null;
  /** The latest answer's clock; null before the first good answer. */
  now: number | null;
  /** The org's boards with the key digits Transfer shows ("Trusted board AB12"); empty before the first answer. */
  boards: UploadBoard[];
  stalled: ReadonlySet<string>;
  loaded: boolean;
  refreshFailed: boolean;
  /** A change of ours (an action's request) begins / has settled: no list read that overlaps it is painted. */
  begin: () => void;
  end: () => void;
  /** Reads the list at once (and restarts the poll), resolving when that read has settled. */
  refreshNow: () => Promise<void>;
};

const Ctx = createContext<Staging | null>(null);

export function useStaging(): Staging {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStaging outside StagingProvider');
  return s;
}

const isAnswer = (v: unknown): v is { rows: ServerRow[]; targets: SendTarget[]; boards?: UploadBoard[]; now: number } =>
  !!v && typeof v === 'object' && Array.isArray((v as { rows?: unknown }).rows);

/**
 * The Upload page's one staging list (spec 2026-10-23 §4): the browser's own rows (library uploads and send uploads,
 * this visit only) and the last /api/staging answer (sends and Amiga files of every board), polled here so both drop
 * areas and the list read the same state.
 */
export function StagingProvider({ children }: { children: React.ReactNode }) {
  const [libRows, setLib] = useState<LibRow[]>([]);
  const [upRows, setUp] = useState<UpRow[]>([]);
  const [serverRows, setServerRows] = useState<ServerRow[]>([]);
  const [targets, setTargets] = useState<SendTarget[] | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [boards, setBoards] = useState<UploadBoard[]>([]);
  const [stalled, setStalled] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const clock = useRef(idleClock());   // changes of ours: a read that overlaps one is stale (readIsCurrent)
  const seq = useRef(0);          // read order: an answer older than one already painted is not painted
  const painted = useRef(0);
  const seen = useRef<Seen>({});
  const active = useRef(false);
  const restart = useRef<() => Promise<void>>(async () => undefined);

  const refresh = useCallback(async () => {
    const startedAt = clock.current;
    const mine = ++seq.current;
    try {
      const res = await fetch('/api/staging', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      // Signed out, the fetch follows requireOrg's redirect to the sign-in page: not OK, or not this JSON.
      const body: unknown = res.ok ? await res.json() : null;
      if (!isAnswer(body)) throw new Error('not a staging answer');
      if (!readIsCurrent(startedAt, clock.current) || mine < painted.current) return;
      painted.current = mine;
      const t = Date.now();
      const s = trackStalls(seen.current, body.rows, t);
      seen.current = s.seen;
      setServerRows(body.rows);
      setTargets(Array.isArray(body.targets) ? body.targets : []);
      setBoards(Array.isArray(body.boards) ? body.boards : []);
      setNow(typeof body.now === 'number' ? body.now : t);
      setStalled(s.stalled);
      setLoaded(true);
      setRefreshFailed(false);
    } catch {
      // Offline, signed out, a deploy or a 5xx: the last rows stay, and the list says it could not refresh.
      if (mine >= painted.current) setRefreshFailed(true);
    }
  }, []);

  useEffect(() => {
    active.current = anyMoving([...serverRows, ...libRows, ...upRows], stalled);
  }, [serverRows, libRows, upRows, stalled]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One loop at a time: a tick still awaiting its read when the loop restarts belongs to an older generation, and
    // does not schedule the next one (clearing the timer alone misses it -- that timer has already fired).
    let gen = 0;
    const tick = async (g: number) => {
      if (stopped || g !== gen) return;
      if (document.visibilityState === 'visible') await refresh();
      if (!stopped && g === gen) timer = setTimeout(() => void tick(g), active.current ? ACTIVE_MS : IDLE_MS);
    };
    restart.current = async () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      await tick(++gen);
    };
    void tick(gen);
    // Coming back to the tab reads the list at once, and restarts the loop.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void restart.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);

  const setLibRows = useCallback((fn: (rows: LibRow[]) => LibRow[]) => setLib(fn), []);
  const addUp = useCallback((row: UpRow) => setUp((rs) => [...rs.filter((r) => r.key !== row.key), row]), []);
  const patchUp = useCallback((key: string, patch: Partial<UpRow>) =>
    setUp((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))), []);
  const removeLocal = useCallback((keys: string[]) => {
    const gone = new Set(keys);
    setLib((rs) => rs.filter((r) => !gone.has(r.key)));
    setUp((rs) => rs.filter((r) => !gone.has(r.key)));
    setServerRows((rs) => rs.filter((r) => !gone.has(r.key)));
  }, []);
  const begin = useCallback(() => { clock.current = beginChange(clock.current); }, []);
  const end = useCallback(() => { clock.current = endChange(clock.current); }, []);
  const refreshNow = useCallback(() => restart.current(), []);

  const value = useMemo<Staging>(() => ({
    libRows, upRows, setLibRows, addUp, patchUp, removeLocal, serverRows, targets, now, boards, stalled, loaded, refreshFailed,
    begin, end, refreshNow,
  }), [libRows, upRows, setLibRows, addUp, patchUp, removeLocal, serverRows, targets, now, boards, stalled, loaded, refreshFailed, begin, end, refreshNow]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
