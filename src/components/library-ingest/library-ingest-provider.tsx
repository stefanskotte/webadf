'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useLibraryIngest } from './use-library-ingest';
import { diskFilesFromDrop, type DropFileItem } from '@/lib/library-ingest/drop-files';
import { newRow, upsertLibRows, type LibRow } from '@/lib/library-ingest/rows';
import { stampDrops, trayOrder, type TrayPlace } from '@/lib/library-ingest/tray';
import type { Suggestion } from '@/lib/disk-set-suggest';
import type { FetchedRow } from '@/components/ingest/url-fetch';

type LibraryIngest = {
  /** The tray's rows, newest drop first (R9). */
  rows: LibRow[];
  /** One line per archive whose other files were left out (drop-files.ts). */
  notes: string[];
  /** A drop is being read, opened or added: the overlay takes no drop and Close is disabled. */
  busy: boolean;
  setBusy(b: boolean): void;
  suggestion: Suggestion;
  clearSuggestion(): void;
  /** Dropped or picked items (folders already walked): archives opened, images added, the rest refused in the tray. */
  addItems(items: DropFileItem[] | Promise<DropFileItem[]>): Promise<void>;
  addFetched(rows: FetchedRow[], since: string): Promise<void>;
  /** Empties the tray (only when nothing is running). */
  close(): void;
};

const Ctx = createContext<LibraryIngest | null>(null);

/**
 * The Library page's own library ingest (Files increment 3, R8/R9): useLibraryIngest with its rows in this provider,
 * stamped with the drop they came from so the tray lists the newest drop first. It wraps the header and the body, so
 * the header's Add disks ▾ menu, the page-wide drop overlay and the tray share one state.
 */
export function LibraryIngestProvider({ children }: { children: ReactNode }) {
  // The rows with the drop each came from (stampDrops), kept together so one update changes both.
  const [tray, setTray] = useState<{ rows: LibRow[]; dropOf: ReadonlyMap<string, TrayPlace> }>({ rows: [], dropOf: new Map() });
  const [notes, setNotes] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  // Counted up as each drop or URL fetch starts; read inside the updater, never in render.
  const drop = useRef(0);

  const setRows = useCallback((fn: (rs: LibRow[]) => LibRow[]) => {
    setTray((prev) => {
      const next = fn(prev.rows);
      return { rows: next, dropOf: stampDrops(prev.rows, next, prev.dropOf, drop.current) };
    });
  }, []);
  const ingest = useLibraryIngest({ setRows });

  async function addItems(items: DropFileItem[] | Promise<DropFileItem[]>) {
    drop.current++;
    setReading(true);
    let files: File[] = [];
    try {
      const r = await diskFilesFromDrop(await items);
      files = r.files;
      if (r.notes.length) setNotes((ns) => [...r.notes, ...ns]);
      // Named in the tray as failed rows, keyed `bad:<name>` as the pipeline's own refusals are.
      if (r.refused.length) {
        setRows((rs) => upsertLibRows(rs, r.refused.map((x) => newRow(x.name, 0, `bad:${x.name}`, 'failed', x.reason))));
      }
    } catch {
      setRows((rs) => upsertLibRows(rs, [newRow('Dropped files', 0, 'bad:drop', 'failed', 'could not be read')]));
    } finally {
      setReading(false);
    }
    if (files.length) await ingest.addFiles(files);
  }

  async function addFetched(fetched: FetchedRow[], since: string) {
    drop.current++;
    await ingest.addFetched(fetched, since);
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
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibraryIngestContext(): LibraryIngest {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLibraryIngestContext outside LibraryIngestProvider');
  return v;
}
