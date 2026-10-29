// A library drop's rows (client-safe, no imports): what each dropped or fetched disk image is doing. Moved out of
// src/lib/upload-staging.ts, which re-exports them, so the Library page can show them without the Staging list.

export type LibState = 'hashing' | 'uploading' | 'deduped' | 'done' | 'failed';
export type LibRow = {
  source: 'lib'; key: string; kind: 'lib'; name: string; sizeBytes: number; state: LibState;
  note?: string; title: { gameId: string; title: string } | null; at: number;
};
export type LibTitle = { gameId: string; title: string };

/** A library row's key in the staging list (spec 2026-10-23 §4): its sha256, or `bad:<filename>` before hashing. */
export const libKey = (sha: string) => `lib:${sha}`;

/** A new library row. Its `at` is the drop time the list sorts by. A dropped .dms that cannot be decoded has to SAY
 *  so in its note: silently dropping it from the list is how the old behaviour looked -- the file appeared to upload
 *  and then could never be mounted. */
export function newRow(name: string, sizeBytes: number, sha: string, state: LibState, note?: string, title: LibTitle | null = null): LibRow {
  return { source: 'lib', key: libKey(sha), kind: 'lib', name, sizeBytes, state, note, title, at: Date.now() };
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
