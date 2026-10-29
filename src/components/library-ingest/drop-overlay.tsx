'use client';
import { useEffect, useRef, useState } from 'react';
import { isFileDrag } from '@/components/disks/native-drop';
import { readDroppedItems } from '@/lib/drop-reader';
import { toast } from 'sonner';
import { DROP_WAIT, useLibraryIngestContext } from './library-ingest-provider';

/** "Drop to add 3 disks to the library" when every dragged item is a file (a folder is one too), else no number. */
function headline(dt: DataTransfer | null): string {
  const items = dt?.items ? Array.from(dt.items) : [];
  const n = items.length > 0 && items.every((i) => i.kind === 'file') ? items.length : 0;
  return n > 0 ? `Drop to add ${n} disk${n === 1 ? '' : 's'} to the library` : 'Drop to add disks to the library';
}

/**
 * The whole Library page takes dropped disks (Files increment 3, R8; mock-up part 3): a file dragged in from the
 * computer lights up a full-page overlay, and a drop anywhere hands the items to the page's library ingest. Only OS
 * file drags count -- `dataTransfer.types` holds 'Files' -- so dnd-kit's drags of titles onto collections and sets,
 * which are pointer events with no native drag at all, never see it. While a drop is still being added the overlay
 * says so and takes nothing (the tray is one drop at a time).
 *
 * The listeners are on `window`, so a drop on any part of the page (the rail, the header, the gaps) counts. The hidden
 * marker says `data-native-drop="ready"` once they are attached, which is what e2e's synthDrop waits for.
 */
export function LibraryDropOverlay() {
  const ingest = useLibraryIngestContext();
  const [shown, setShown] = useState<string | null>(null);
  const marker = useRef<HTMLSpanElement>(null);
  // The listeners are attached once; they read the latest busy flag and addItems through this ref.
  const live = useRef(ingest);
  useEffect(() => { live.current = ingest; });

  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth++;
      setShown(headline(e.dataTransfer));
    };
    const over = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      // Without this the browser opens the dropped file in the tab instead of handing it to the page.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = live.current.busy ? 'none' : 'copy';
      setShown((s) => s ?? headline(e.dataTransfer));
    };
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setShown(null);
    };
    const drop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setShown(null);
      if (!e.dataTransfer) return;
      if (live.current.busy) { toast(DROP_WAIT); return; }
      // Read before this handler returns: the browser empties the DataTransfer after it (drop-reader.ts).
      const items = readDroppedItems(e.dataTransfer.items)
        .then((all) => all.map((d) => ({ name: d.path, kind: d.kind, file: d.file })));
      void live.current.addItems(items);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    if (marker.current) marker.current.dataset.nativeDrop = 'ready';
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <>
      <span ref={marker} hidden data-testid="library-drop-target" data-native-drop="waiting" />
      {shown !== null && (
        <div data-testid="library-drop-overlay" aria-live="polite"
             className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4"
             style={{ background: 'var(--scrim)' }}>
          <div className="glass-card flex max-w-[480px] flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center"
               style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)', color: 'var(--ink)' }}>
            <h3 className="text-[20px] font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              {ingest.busy ? DROP_WAIT.slice(0, -1) : shown}
            </h3>
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>ADF · DSK · ADZ · DMS · DMZ · HFE, folders, .zip / .lha of disks</p>
          </div>
        </div>
      )}
    </>
  );
}
