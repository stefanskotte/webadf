'use client';

import { useState } from 'react';
import { HelpTip } from '@/components/help/help-tip';
import { DropCard, INK_LABEL, INK_STYLE, TILE, TILE_LOOK } from '@/components/ingest/drop-card';
import { readDroppedItems, type DroppedItem } from '@/lib/drop-reader';
import { describeUrlRefusal } from '@/lib/url-ingest-messages';

/** The "?" placed as the Send zone's is (send-drop-zone.tsx): over the tile's corner on a phone. */
const STASH_HELP = 'max-sm:z-20 max-sm:col-start-2 max-sm:row-start-1 max-sm:m-1.5 max-sm:self-start max-sm:justify-self-end';

/**
 * "Drop files into STASH:" (Files spec 2026-10-29 §5, R1): the Files page's top drop zone. A drop on the card, or the
 * files Browse files picks, go to the STASH: root; the manager uploads them (useStashUpload) and says what landed.
 * Paste URL asks the server to fetch one file into the STASH: root (R7). Folders and .lha/.zip are stored as they are.
 */
export function StashDropZone({ busy, onItems, onFetched }: {
  /** The manager's work in progress, in words ("Uploading 3 of 12…"), or null when it is idle. */
  busy: string | null;
  /** The dropped or picked items, still being read: the manager checks clashes and uploads them. */
  onItems(items: Promise<DroppedItem[]>): void;
  /** A URL was fetched into STASH: (`path` where it landed): the panes reload. */
  onFetched(path: string): void;
}) {
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'muted' | 'danger' | 'ok' } | null>(null);
  const working = busy !== null || fetching;

  function picked(files: FileList | null) {
    if (!files?.length) return;
    onItems(Promise.resolve([...files].map((file) => ({ path: file.name, kind: 'file' as const, file, sizeBytes: file.size }))));
  }

  async function fetchUrl(e: React.FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (!value || working) return;
    setFetching(true);
    setStatus({ text: 'Fetching… the server is downloading the file.', tone: 'muted' });
    try {
      const res = await fetch('/api/files/stash/url', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string; status?: number; retryAfter?: number };
      if (!res.ok || !data.path) {
        setStatus({ text: describeUrlRefusal(data.error ?? '', data.status, data.retryAfter), tone: 'danger' });
        return;
      }
      setStatus({ text: `Fetched into ${data.path}.`, tone: 'ok' });
      setUrl('');
      onFetched(data.path);
    } catch {
      setStatus({ text: describeUrlRefusal(''), tone: 'danger' });
    } finally {
      setFetching(false);
    }
  }

  const color = status?.tone === 'danger' ? 'var(--danger-fg)' : status?.tone === 'ok' ? 'var(--success-fg)' : 'var(--muted-2)';

  return (
    <DropCard testId="files-drop-stash" headingId="files-drop-stash-heading" title="Drop files into STASH:"
              help={<HelpTip topic="stash-net" className={STASH_HELP} />}
              hint="Any file or folder, up to 20 MB a file. .lha and .zip stay whole — open them in the pane."
              disk={{ color: 'grey', set: 'ANY FILE · .LHA · .ZIP', title: 'STASH:' }} tileCol="full" disabled={working}
              // Read before this handler returns: the browser empties the DataTransfer after it (drop-reader.ts).
              onItems={(items) => onItems(readDroppedItems(items))}>
      <div className="flex flex-col gap-2 max-sm:contents sm:flex-row sm:flex-wrap sm:items-center">
        <label htmlFor="files-stash-input" data-testid="files-stash-browse" data-tile={working ? 'Working…' : 'Into STASH:'}
               className={`${INK_LABEL} ${TILE_LOOK} ${TILE.full}`} style={INK_STYLE}>
          <span className="max-sm:hidden">{working ? 'Working…' : 'Browse files'}</span>
          <input id="files-stash-input" type="file" multiple aria-label="Browse files" className="sr-only"
                 data-testid="files-stash-input" disabled={working}
                 onChange={(e) => { picked(e.target.files); e.target.value = ''; }} />
        </label>
        <form onSubmit={fetchUrl} data-testid="files-stash-url" noValidate
              className="flex h-[46px] w-full min-w-0 items-center gap-1.5 rounded-[10px] border px-2.5 max-sm:order-2 max-sm:col-span-2 sm:h-[38px] sm:w-auto sm:min-w-[220px] sm:flex-1"
              style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
          <input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="or paste a URL…"
                 aria-label="Paste a URL to fetch into STASH:" data-testid="files-stash-url-input" value={url}
                 onChange={(e) => setUrl(e.target.value)} disabled={working} aria-describedby="files-stash-url-status"
                 className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-[var(--muted-2)]"
                 style={{ color: 'var(--ink)' }} />
          <button type="submit" data-testid="files-stash-url-fetch" disabled={working || url.trim() === ''}
                  className="h-11 shrink-0 rounded-[8px] border px-2.5 text-[12px] font-semibold disabled:opacity-50 sm:h-7"
                  style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
            {fetching ? 'Working…' : 'Fetch'}
          </button>
        </form>
        <p id="files-stash-url-status" role="status" aria-live="polite" data-testid="files-stash-url-status"
           className="min-h-[1em] basis-full text-[12px] max-sm:order-2 max-sm:col-span-2" style={{ color }}>
          {status?.text ?? ''}
        </p>
        <p role="status" aria-live="polite" data-testid="files-stash-progress"
           className="basis-full text-[12px] empty:hidden max-sm:order-2 max-sm:col-span-2" style={{ color: 'var(--muted)' }}>
          {busy ?? ''}
        </p>
      </div>
    </DropCard>
  );
}
