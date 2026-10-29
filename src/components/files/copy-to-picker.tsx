'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import type { FsEntry, Listing } from '@/lib/files/types';
import { refusalWords } from '@/lib/files/words';
import { holdsFiles } from '@/lib/files/pane-rules';
import { PANE_DEVICES } from '@/lib/files/path';
import { managerReturnsFocus } from './dialogs';

/**
 * Copy to… / Move to… on a phone (Files increment 1, Task 10): where the desktop copies into the other pane, a phone
 * shows one pane, so this picks the place instead. It starts at the other pane's location and walks STASH: and LIBRARY:
 * through /api/files/list (`list`, the manager's own fetch) -- the device chips, crumbs back up, the folders, titles and
 * disks to go into -- and hands back the listing it ends at; the manager runs the copy or move as the desktop does.
 */
export type ListResult = { listing: Listing } | { gone: true } | { error: string };

export type CopyToPickerProps = {
  op: 'copy' | 'move'; count: number; start: string; busy: boolean;
  list(path: string): Promise<ListResult>;
  onPick(listing: Listing): void; onCancel(): void;
};

/** Why the place shown cannot take the copy, or null when it can: a writable folder inside a disk or in STASH:. */
export function pickReason(op: 'copy' | 'move', l: Listing | null): string | null {
  if (!l) return null;
  if (!holdsFiles(l)) return `Open a disk or STASH: to ${op} into it`;
  if (!l.writable) return refusalWords('read_only', l.readOnlyReason ?? undefined);
  return null;
}

/** What can be gone into: everything but files and archives (an archive is read-only: nothing goes into it). */
export function placesIn(l: Listing): FsEntry[] {
  return l.entries.filter((e) => e.kind !== 'file' && e.kind !== 'archive').sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

const PLACE_GLYPH: Record<string, string> = { title: 'TTL', disk: 'DSK', dir: 'DIR' };

export function CopyToPicker({ op, count, start, busy, list, onPick, onCancel }: CopyToPickerProps) {
  const [path, setPath] = useState(start);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The newest place wins: a slow listing for a place already left is dropped.
  useEffect(() => {
    let live = true;
    void list(path).then((r) => {
      if (!live) return;
      if ('listing' in r) { setListing(r.listing); setError(null); }
      else setError('gone' in r ? 'This place no longer exists.' : r.error);
    });
    return () => { live = false; };
  }, [list, path]);

  const shown = listing && listing.path === path ? listing : null;
  const reason = pickReason(op, shown);
  const what = count === 1 ? '1 item' : `${count} items`;
  const crumbs = listing?.crumbs ?? [];
  const tap = 'max-lg:min-h-11 focus-visible:outline-2 focus-visible:outline-(--ring)';

  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onCancel(); }} width={440} testId="files-copy-to"
           closeTestId="files-copy-to-close" dismissible={!busy}
           title={op === 'copy' ? 'Copy to…' : 'Move to…'} subtitle={`${op === 'copy' ? 'Copy' : 'Move'} ${what} into the folder shown`}
           footer={(
             <div className="flex w-full items-center justify-end gap-2.5">
               <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
               <Button onClick={() => shown && onPick(shown)} disabled={busy || !shown || reason !== null}
                       data-testid="files-copy-to-here">
                 {op === 'copy' ? 'Copy here' : 'Move here'}
               </Button>
             </div>
           )}>
      <div className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--ink)' }}>
        <div className="flex gap-1.5" role="group" aria-label="Device">
          {PANE_DEVICES.map((d) => {
            const on = (listing?.path ?? path).startsWith(`${d}:`);
            return (
              <button key={d} type="button" aria-pressed={on} data-testid={`files-copy-to-dev-${d}`} onClick={() => setPath(`${d}:`)}
                      className={`rounded-[7px] px-3 py-1 font-mono text-[12px] ${tap}`}
                      style={on ? { background: 'var(--ink)', color: 'var(--surface)' } : { background: 'var(--track)', color: 'var(--muted)' }}>
                {d}:
              </button>
            );
          })}
        </div>
        <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center font-mono text-[13px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center">
              {i > 0 && !crumbs[i - 1].label.endsWith(':') && <span aria-hidden style={{ color: 'var(--muted-2)' }}>/</span>}
              <button type="button" data-testid={`files-copy-to-crumb-${i}`} onClick={() => setPath(c.path)}
                      aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                      className={`rounded-[4px] px-1 font-medium [overflow-wrap:anywhere] ${tap}`}>{c.label}</button>
            </span>
          ))}
        </nav>
        {error && <p role="alert" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</p>}
        {!shown && !error && <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Loading…</p>}
        {shown && (
          <ul className="flex flex-col overflow-hidden rounded-[12px] border" style={{ borderColor: 'var(--line)' }} aria-busy={busy || undefined}>
            {placesIn(shown).map((e) => (
              <li key={e.path} className="border-b last:border-b-0" style={{ borderColor: 'var(--hairline)' }}>
                <button type="button" data-testid="files-copy-to-folder" data-name={e.name} onClick={() => setPath(e.path)}
                        className={`flex min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left hover:bg-[var(--surface-2)] ${tap}`}>
                  <span aria-hidden className="shrink-0 rounded-[4px] px-[5px] py-px font-mono text-[10px] font-semibold"
                        style={{ background: 'var(--dir-bg)', color: 'var(--accent-blue)' }}>{PLACE_GLYPH[e.kind]}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{e.name}</span>
                  <span aria-hidden style={{ color: 'var(--muted-2)' }}>›</span>
                </button>
              </li>
            ))}
            {placesIn(shown).length === 0 && (
              <li className="px-3 py-3 text-[13px]" style={{ color: 'var(--muted)' }}>No folders here.</li>
            )}
          </ul>
        )}
        {reason && (
          <p data-testid="files-copy-to-reason" className="text-[13px]" style={{ color: 'var(--muted)' }}>{reason}</p>
        )}
      </div>
    </Modal>
  );
}
