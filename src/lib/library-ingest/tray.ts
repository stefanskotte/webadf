// The Library page's results tray (Files increment 3, ruling R9), in words. Client-safe.

import { newRow, type LibRow } from './rows';
import type { DropRefusal } from './drop-files';

/** "3 added · 1 refused", and "· 2 working" while any row is still hashing or uploading. A disk the library already
 *  had is added too (Files 2 §5: one "Added"; the server only skipped the upload). A count of nothing is left out. */
export function traySummary(rows: LibRow[]): string {
  let added = 0, refused = 0, working = 0;
  for (const r of rows) {
    if (r.state === 'done' || r.state === 'deduped') added++;
    else if (r.state === 'failed') refused++;
    else working++;
  }
  return [added && `${added} added`, refused && `${refused} refused`, working && `${working} working`].filter(Boolean).join(' · ');
}

/** One row's state word and tone: Hashing… / Uploading… / Added / Refused (— why). */
export function trayState(r: LibRow): { word: string; tone: 'busy' | 'done' | 'wait' | 'fail' } {
  switch (r.state) {
    case 'hashing': return { word: 'Hashing…', tone: 'busy' };
    case 'uploading': return { word: 'Uploading…', tone: 'busy' };
    case 'done': case 'deduped': return { word: 'Added', tone: 'done' };
    case 'failed': return { word: r.note ? `Refused — ${r.note}` : 'Refused', tone: 'fail' };
  }
}

/** Where a row sits in the tray: the drop it came from, and its place in that drop. */
export type TrayPlace = { drop: number; seq: number };

/**
 * Which drop each row belongs to, for "newest drop's rows first" (R9). A row is the latest drop's when it is new or
 * was made afresh (newRow gives it a new `at`: the same disk dropped again resets in place, and moves up with its
 * drop); a state patch keeps its `at` and so its place. Rows stamped in one update take their places in the order
 * they come. Returns a new map.
 */
export function stampDrops(prev: LibRow[], next: LibRow[], placeOf: ReadonlyMap<string, TrayPlace>, drop: number): Map<string, TrayPlace> {
  const before = new Map(prev.map((r) => [r.key, r.at]));
  let seq = Math.max(0, ...[...placeOf.values()].filter((p) => p.drop === drop).map((p) => p.seq));
  const out = new Map<string, TrayPlace>();
  for (const r of next) {
    const kept = placeOf.get(r.key);
    out.set(r.key, kept && before.get(r.key) === r.at ? kept : { drop, seq: ++seq });
  }
  return out;
}

/** The rows newest drop first, each drop's rows in the order they came. */
export function trayOrder(rows: LibRow[], placeOf: ReadonlyMap<string, TrayPlace>): LibRow[] {
  const at = (r: LibRow) => placeOf.get(r.key) ?? { drop: 0, seq: 0 };
  return [...rows].sort((a, b) => at(b).drop - at(a).drop || at(a).seq - at(b).seq);
}

/**
 * A drop's refusals as failed tray rows. Each is keyed by its drop and its place in it (`bad:<drop>.<i>:<name>`), not
 * by its name alone: two readme.txt from different folders are two refusals, and a name key would fold them into one
 * row and undercount the summary.
 */
export function refusedRows(refused: DropRefusal[], drop: number): LibRow[] {
  return refused.map((x, i) => newRow(x.name, 0, `bad:${drop}.${i}:${x.name}`, 'failed', x.reason));
}
