// The A6 Upload staging model (client-safe, types only).
export type ServerRow = {
  source: 'server';
  key: string;                                   // 'send:<id>' | 'amiga:<id>'
  kind: 'out' | 'in';
  id: string;
  name: string;                                  // send: path; amiga: path
  sizeBytes: number;
  board: { id: string | null; name: string };
  status: 'queued' | 'sending' | 'delivered' | 'failed' | 'cancelled' | 'expired' | 'receiving' | 'stored';
  doneBytes: number;                             // bytesSent / receivedBytes
  pct: number | null;                            // sending/receiving: min(99, floor(done*100/size)); else null
  savedAs: string | null;
  error: string | null;                          // failed: failureText / uploadFailureText; else null
  isDiskImage: boolean;                          // amiga: libraryEligible(path, size); send: false
  title: { gameId: string; title: string } | null;
  at: number;                                    // createdAt ms
};

// ---- The staging logic: pure and client-safe (value imports: formatSize, STALL_MS only). ----
import { formatSize } from '@/lib/send-ui';
import { STALL_MS } from '@/lib/from-amiga-ui';

export type LibState = 'hashing' | 'uploading' | 'deduped' | 'done' | 'failed';
export type LibRow = {
  source: 'lib'; key: string; kind: 'lib'; name: string; sizeBytes: number; state: LibState;
  note?: string; title: { gameId: string; title: string } | null; at: number;
};
export type UpRow = {
  source: 'up'; key: string; kind: 'out'; name: string; sizeBytes: number;
  state: 'uploading' | 'failed'; note?: string; boardName: string; at: number;
};
export type StagingRowAny = ServerRow | LibRow | UpRow;
export type StagingFilter = 'all' | 'in' | 'out' | 'lib';
export type Tone = 'done' | 'busy' | 'wait' | 'fail';
export type StagingAction = 'open' | 'add' | 'download' | 'send' | 'delete' | 'stop' | 'cancel' | 'retry' | 'clear';
export type ViewRow = {
  key: string; kind: 'lib' | 'out' | 'in'; state: string; name: string; where: string;
  size: string; status: string; tone: Tone; note: string | null; actions: StagingAction[];
  gameId: string | null; row: StagingRowAny;
};

export function mergeStaging(server: ServerRow[], browser: (LibRow | UpRow)[]): StagingRowAny[] {
  const all: StagingRowAny[] = [...server, ...browser];
  return all.sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const failed = (note: string | null | undefined) => (note ? `Failed · ${note}` : 'Failed');

type Body = Pick<ViewRow, 'state' | 'where' | 'status' | 'tone' | 'note' | 'actions' | 'gameId'>;

function serverBody(r: ServerRow, stalled: ReadonlySet<string>): Body {
  const pct = r.pct ?? 0;
  if (r.kind === 'out') {
    const where = `to ${r.board.name}`;
    const b = (status: string, tone: Tone, actions: StagingAction[], w = where): Body =>
      ({ state: r.status, where: w, status, tone, note: null, actions, gameId: null });
    switch (r.status) {
      case 'queued': return b('Waiting for the Amiga', 'wait', ['cancel']);
      case 'sending': return b(`Sending · ${pct} %`, 'busy', ['cancel']);
      case 'delivered': return b('Delivered', 'done', ['clear'], r.savedAs ? `${where} · saved as ${r.savedAs}` : where);
      case 'failed': return b(failed(r.error), 'fail', ['retry', 'clear']);
      case 'expired': return b('Expired', 'fail', ['retry', 'clear']);
      default: return b('Cancelled', 'wait', ['clear']);
    }
  }
  const where = `from ${r.board.name}`;
  const gameId = r.title?.gameId ?? null;
  if (r.status === 'receiving') {
    const text = stalled.has(r.key) ? `Stopped at ${pct} %` : `Arriving · ${pct} %`;
    return { state: r.status, where, status: text, tone: 'busy', note: null, actions: ['stop'], gameId };
  }
  if (r.status === 'stored') {
    const first: StagingAction[] = r.title ? ['open'] : r.isDiskImage ? ['add'] : [];
    return {
      state: r.status, where, status: r.isDiskImage ? 'Stored · a disk image' : 'Stored', tone: 'done', note: null,
      actions: [...first, 'download', 'send', 'delete'], gameId,
    };
  }
  return { state: r.status, where, status: failed(r.error), tone: 'fail', note: null, actions: ['clear'], gameId };
}

function libBody(r: LibRow): Body {
  const base = { state: r.state, gameId: r.title?.gameId ?? null };
  const where = r.title ? `into the library · ${r.title.title}` : 'into the library';
  const open: StagingAction[] = r.title ? ['open'] : [];
  switch (r.state) {
    case 'hashing': return { ...base, where, status: 'Checking…', tone: 'busy', note: r.note ?? null, actions: [] };
    case 'uploading': return { ...base, where, status: 'Uploading…', tone: 'busy', note: r.note ?? null, actions: [] };
    case 'deduped': return { ...base, where, status: 'Already in the library', tone: 'done', note: r.note ?? null, actions: open };
    case 'done': return { ...base, where, status: 'Added', tone: 'done', note: r.note ?? null, actions: open };
    default: return { ...base, where, status: failed(r.note), tone: 'fail', note: null, actions: ['clear'] };
  }
}

function upBody(r: UpRow): Body {
  const where = `to ${r.boardName}`;
  return r.state === 'uploading'
    ? { state: r.state, where, status: 'Uploading…', tone: 'busy', note: null, actions: [], gameId: null }
    : { state: r.state, where, status: failed(r.note), tone: 'fail', note: null, actions: ['clear'], gameId: null };
}

function toView(r: StagingRowAny, stalled: ReadonlySet<string>): ViewRow {
  const body = r.source === 'server' ? serverBody(r, stalled) : r.source === 'lib' ? libBody(r) : upBody(r);
  return { key: r.key, kind: r.kind, name: r.name, size: formatSize(r.sizeBytes), row: r, ...body };
}

export function stagingView(rows: StagingRowAny[], filter: StagingFilter, stalled: ReadonlySet<string>):
  { shown: ViewRow[]; counts: Record<StagingFilter, number>; clearServer: string[]; clearLocal: string[] } {
  const counts: Record<StagingFilter, number> = { all: rows.length, in: 0, out: 0, lib: 0 };
  for (const r of rows) counts[r.kind]++;
  const shown = rows.filter((r) => filter === 'all' || r.kind === filter).map((r) => toView(r, stalled));
  const clearServer: string[] = [];
  const clearLocal: string[] = [];
  for (const v of shown) {
    if (!v.actions.includes('clear')) continue;
    (v.row.source === 'server' ? clearServer : clearLocal).push(v.key);
  }
  return { shown, counts, clearServer, clearLocal };
}

/** Same key replaces in place; new keys append. */
export function upsertLibRows(rows: LibRow[], next: LibRow[]): LibRow[] {
  const out = [...rows];
  for (const n of next) {
    const i = out.findIndex((r) => r.key === n.key);
    if (i >= 0) out[i] = n; else out.push(n);
  }
  return out;
}

/** Something is still moving: only then is the server list polled fast. */
export function anyMoving(rows: StagingRowAny[], stalled: ReadonlySet<string>): boolean {
  return rows.some((r) => {
    if (r.source === 'server') {
      return r.status === 'queued' || r.status === 'sending' || (r.status === 'receiving' && !stalled.has(r.key));
    }
    return r.state === 'hashing' || r.state === 'uploading';
  });
}

type Seen = Record<string, { bytes: number; since: number }>;
/** Per receiving row (by key): restart the clock when bytes move; stalled after STALL_MS at the same count. */
export function trackStalls(prev: Seen, rows: ServerRow[], now: number): { seen: Seen; stalled: Set<string> } {
  const seen: Seen = {};
  const stalled = new Set<string>();
  for (const r of rows) {
    if (r.status !== 'receiving') continue;
    const p = prev[r.key];
    seen[r.key] = p && p.bytes === r.doneBytes ? p : { bytes: r.doneBytes, since: now };
    if (now - seen[r.key].since >= STALL_MS) stalled.add(r.key);
  }
  return { seen, stalled };
}
