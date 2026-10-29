'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useLibraryIngest } from './use-library-ingest';
import { diskFilesFromDrop, type DropFileItem } from '@/lib/library-ingest/drop-files';
import { newRow, upsertLibRows, type LibRow } from '@/lib/library-ingest/rows';
import { refusedRows, stampDrops, trayOrder, type TrayPlace } from '@/lib/library-ingest/tray';
import type { Suggestion } from '@/lib/disk-set-suggest';
import type { FetchedRow } from '@/components/ingest/url-fetch';

type LibraryIngest = {
  /** The tray's rows, newest drop first (R9). */
  rows: LibRow[];
  /** One line per archive whose other files were left out (drop-files.ts), each with its own key: two drops of the
   *  same archive say the same words. */
  notes: { key: number; text: string }[];
  /** A drop is being read, opened, added or given its set suggestion: the overlay and Add disks ▾ take no drop and
   *  Close is disabled. */
  busy: boolean;
  setBusy(b: boolean): void;
  suggestion: Suggestion;
  clearSuggestion(): void;
  /** Dropped or picked items (folders already walked): archives opened, images added, the rest refused in the tray. */
  addItems(items: DropFileItem[] | Promise<DropFileItem[]>): Promise<void>;
  addFetched(rows: FetchedRow[], since: string): Promise<void>;
  /** Empties the tray (only when nothing is running). */
  close(): void;
  /** The header's Add disks ▾ menu is open; held here so the empty library's Add disks button can open it (R11). */
  menuOpen: boolean;
  setMenuOpen(open: boolean): void;
};

/** What a drop refused because another is still being added hears (the overlay says it while one is dragged). */
export const DROP_WAIT = 'Wait for the disks being added, then drop again.';

const Ctx = createContext<LibraryIngest | null>(null);

/**
 * The Library page's own library ingest (Files increment 3, R8/R9): useLibraryIngest with its rows in this provider,
 * stamped with the drop they came from so the tray lists the newest drop first. It wraps the header and the body, so
 * the header's Add disks ▾ menu, the page-wide drop overlay and the tray share one state.
 */
export function LibraryIngestProvider({ children }: { children: ReactNode }) {
  // The rows with the drop each came from (stampDrops), kept together so one update changes both.
  const [tray, setTray] = useState<{ rows: LibRow[]; dropOf: ReadonlyMap<string, TrayPlace> }>({ rows: [], dropOf: new Map() });
  const [notes, setNotes] = useState<{ key: number; text: string }[]>([]);
  const noteSeq = useRef(0);
  const [reading, setReading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Counted up as each drop or URL fetch starts; read inside the updater, never in render.
  const drop = useRef(0);

  const setRows = useCallback((fn: (rs: LibRow[]) => LibRow[]) => {
    setTray((prev) => {
      const next = fn(prev.rows);
      return { rows: next, dropOf: stampDrops(prev.rows, next, prev.dropOf, drop.current) };
    });
  }, []);
  const ingest = useLibraryIngest({ setRows });

  // One drop at a time, from its first read to its set suggestion (increment 3 final ruling): a drop let in while
  // another was still being added or suggested for would share that one suggestion. A ref, not `busy`, so two drops
  // within one render are serialised too; `busy` is what the overlay, the menu and Close show.
  const running = useRef(false);

  async function addItems(items: DropFileItem[] | Promise<DropFileItem[]>) {
    if (running.current) {
      toast(DROP_WAIT);
      return;
    }
    running.current = true;
    drop.current++;
    setReading(true);
    // A drop of many archives goes up a chunk at a time as they are opened (DROP_CHUNK), not all held in the tab
    // first; its rows land in the tray chunk by chunk under the same drop. An error out of the upload itself is the
    // pipeline's to show on its rows, not "could not be read". The set suggestion waits for the last chunk (endDrop).
    let failedUpload: unknown = null;
    const addChunk = async (chunk: File[]) => {
      try { await ingest.addFiles(chunk, { more: true }); } catch (e) { failedUpload ??= e; }
    };
    try {
      const r = await diskFilesFromDrop(await items, addChunk);
      if (r.notes.length) {
        const added = r.notes.map((text) => ({ key: ++noteSeq.current, text }));
        setNotes((ns) => [...added, ...ns]);
      }
      // Named in the tray as failed rows, one each: keyed by drop and place, not by name (refusedRows).
      if (r.refused.length) {
        const bad = refusedRows(r.refused, drop.current);
        setRows((rs) => upsertLibRows(rs, bad));
      }
    } catch {
      setRows((rs) => upsertLibRows(rs, [newRow('Dropped files', 0, 'bad:drop', 'failed', 'could not be read')]));
    }
    try {
      // One suggestion for the whole drop, once its last chunk is up; the next drop waits for it.
      await ingest.endDrop();
    } finally {
      running.current = false;
      setReading(false);
    }
    if (failedUpload) throw failedUpload;
  }

  // Paste a URL is disabled while a drop runs; its rows are never thrown away, but a drop waits for its suggestion.
  async function addFetched(fetched: FetchedRow[], since: string) {
    const mine = !running.current;
    running.current = true;
    drop.current++;
    setReading(true);
    try {
      await ingest.addFetched(fetched, since);
    } finally {
      if (mine) {
        running.current = false;
        setReading(false);
      }
    }
  }

  const busy = reading || ingest.busy;
  const value: LibraryIngest = {
    rows: trayOrder(tray.rows, tray.dropOf),
    notes,
    busy,
    setBusy: ingest.setBusy,
    suggestion: ingest.suggestion,
    clearSuggestion: ingest.clearSuggestion,
    addItems,
    addFetched,
    close() {
      if (busy) return;
      setTray({ rows: [], dropOf: new Map() });
      setNotes([]);
      ingest.clearSuggestion();
    },
    menuOpen,
    setMenuOpen,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The provider's state, or null outside the Library page (a view rendered without it). */
export function useOptionalLibraryIngest(): LibraryIngest | null {
  return useContext(Ctx);
}

export function useLibraryIngestContext(): LibraryIngest {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLibraryIngestContext outside LibraryIngestProvider');
  return v;
}
