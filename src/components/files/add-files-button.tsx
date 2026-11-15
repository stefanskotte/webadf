'use client';

import { useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * Below lg, inside a disk: "Add files to Empty · Disk 1" (tester report 2026-11-14/15). A phone has no drag from the
 * OS, so before this the only file picker on the page was the top tile, which puts files in STASH:, not on the disk
 * the pane shows -- and a crumb "Disk 1" did not read as "inside the ADF I made". This opens the phone's own picker and
 * hands the files to the review a drop on the pane opens (drop-review.tsx), aimed at the folder shown.
 *
 * Not disabled when the disk cannot take files (in a drive, an HFE): dimmed, and a tap says why (as the phone bar's).
 * From lg the pane takes a drop from the computer, as before, and this is not drawn.
 */
export function AddFilesButton({ side, place, reason, onFiles }: {
  side: 'left' | 'right';
  /** The disk and folder the files land in (insideDiskPlace): "Empty · Disk 1/Docs". */
  place: string;
  /** Why files cannot be added here now, or null. */
  reason: string | null;
  onFiles(files: File[]): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const tid = (s: string) => `pane-${side}-${s}`;
  return (
    <div data-testid={tid('add-files-row')} className="border-b px-3.5 py-2.5 lg:hidden" style={{ borderColor: 'var(--line)' }}>
      <Button type="button" data-testid={tid('add-files')} aria-disabled={reason !== null || undefined}
              aria-describedby={tid('add-files-hint')}
              onClick={() => { if (reason) toast.error(reason); else input.current?.click(); }}
              className="h-auto min-h-11 w-full whitespace-normal py-2 [overflow-wrap:anywhere] aria-disabled:opacity-50">
        Add files to {place}
      </Button>
      <input ref={input} type="file" multiple hidden tabIndex={-1} data-testid={tid('add-files-input')}
             onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ''; if (picked.length) onFiles(picked); }} />
      <p id={tid('add-files-hint')} data-testid={tid('add-files-hint')} className="mt-1.5 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
        Pick files on this phone: they go inside this disk, in the folder shown above.
      </p>
    </div>
  );
}
