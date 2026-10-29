'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toAdf } from '@/lib/archive/disk-image';
import { hashBlob } from '@/lib/browser-hash';
import { inspectHfe } from '@/lib/hfe/inspect';
import type { Suggestion } from '@/lib/disk-set-suggest';
import { DropOutcome, runLibraryIngest, suggestSet, type IngestIo, type IngestOutcome } from '@/lib/library-ingest/run';
import { newRow, upsertLibRows, type LibRow, type LibState } from '@/lib/library-ingest/rows';
import type { FetchedRow } from '@/components/ingest/url-fetch';

type SetRows = (fn: (rows: LibRow[]) => LibRow[]) => void;

const browserIo = (): IngestIo => ({ fetch: (...a) => fetch(...a), hash: hashBlob, toAdf, inspectHfe });

/**
 * The library ingest pipeline (src/lib/library-ingest/run.ts) for a component: busy, the set suggestion, and the rows.
 * The rows are this hook's own state unless `setRows` is given (the Library page's provider stamps each row with its
 * drop; `rows` is then always empty). `onSettled` runs once a drop has finished, beside router.refresh().
 */
export function useLibraryIngest(opts?: { setRows?: SetRows; onSettled?: () => void | Promise<void> }) {
  const router = useRouter();
  const [ownRows, setOwnRows] = useState<LibRow[]>([]);
  const setRows: SetRows = opts?.setRows ?? setOwnRows;
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion>(null);

  // The state each sha256 last settled into, over every drop of this visit: each drop's own `final` is merged in, so
  // a suggestion reads it exactly as the old dropzone's finalState ref did.
  const finalState = useRef(new Map<string, LibState>());

  async function suggestFor(o: IngestOutcome) {
    const s = await suggestSet({ ...o, final: finalState.current }, browserIo());
    if (s) setSuggestion(s);
  }

  // The drop being added, over its chunks: suggested once, after the last (endDrop).
  const drop = useRef(new DropOutcome());

  /**
   * One drop's files, or with `more` one chunk of a drop that goes on (the Library page's provider adds a drop of
   * many archives a chunk at a time): the set suggestion waits for endDrop, so the drop gets one for all it landed.
   */
  async function addFiles(files: File[], part?: { more?: boolean }) {
    setBusy(true);
    // A new drop clears any earlier panel at once (on its first chunk), whether
    // or not this one ends up suggesting anything of its own.
    if (!drop.current.started) setSuggestion(null);
    let out: IngestOutcome | null = null;
    try {
      out = await runLibraryIngest(files, browserIo(), setRows);
    } finally {
      // Runs on every path, so the dropzone/input never stays disabled and the
      // library view always reflects whatever did land.
      setBusy(false);
      router.refresh();
      void opts?.onSettled?.();
      // Fired only after busy/refresh: the suggestion is about what this
      // drop just did, not something that should hold the UI up while it's
      // still uploading.
      if (out) {
        for (const [sha, st] of out.final) finalState.current.set(sha, st);
        drop.current.add(out);
      }
      if (!part?.more) await endDrop();
    }
  }

  /** The drop is all in: its one suggestion, for every chunk it went up in. */
  async function endDrop() {
    const o = drop.current.take();
    if (o) await suggestFor(o);
  }

  // Rows from /api/ingest/url, merged into the rows exactly like a drop's:
  // same states, same notes, same reset-in-place for a repeat sha.
  async function addFetched(fetched: FetchedRow[], since: string) {
    const shas: string[] = [];
    const rows = fetched.map((f) => newRow(f.filename, f.sizeBytes, f.sha256 ?? `bad:${f.filename}`, f.state, f.note, f.title ?? null));
    setRows((rs) => upsertLibRows(rs, rows));
    for (const f of fetched) {
      if (!f.sha256) continue;
      finalState.current.set(f.sha256, f.state);
      shas.push(f.sha256);
    }
    router.refresh();
    setSuggestion(null);
    await suggestFor({ shas, paths: new Map(), final: finalState.current, since });
  }

  return {
    rows: ownRows, busy, setBusy, suggestion, clearSuggestion: () => setSuggestion(null),
    addFiles, endDrop, addFetched, setRows,
  };
}
