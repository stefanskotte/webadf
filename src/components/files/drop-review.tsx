'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { DropStaging } from '@/components/disks/drop-staging';
import { FileEditProvider } from '@/components/disks/file-actions';
import { collectDirectories } from '@/components/disks/file-tree';
import type { DroppedItem } from '@/lib/drop-reader';
import type { DiskInfo, DropReviewData } from '@/lib/files/types';
import { refusalWords } from '@/lib/files/words';
import { managerReturnsFocus, placeName } from './dialogs';

/**
 * Files from the computer dropped on a pane inside a writable disk (Files increment 1, Task 9b): the Browse page's
 * own review (drop-staging.tsx) in a modal -- archives and folders expanded, the destination, rename / skip / replace
 * for each clash, the space check -- then the disk's batch route. `folder` is where the drop landed, from the disk's
 * root ('' for the root itself, names joined by '/'), and becomes the review's destination.
 *
 * The TOSEC confirm has already been asked by the manager, so the review's own FileEditProvider gets no tosecName;
 * `onWritten` hands the saved version back for the manager's versioned toast with Undo.
 */
export function DropReview({ disk, folder, items, onClose, onWritten }: {
  disk: DiskInfo; folder: string; items: Promise<DroppedItem[]>;
  onClose(): void; onWritten(written: { seq: number | null; message: string }): void;
}) {
  const [data, setData] = useState<DropReviewData | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const path = `LIBRARY:/${disk.gameId}/${disk.diskId}`;
      try {
        const res = await fetch(`/api/files/drop-review?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as (DropReviewData & { error?: string; detail?: string }) | null;
        if (!live) return;
        if (res.ok && body) { setData(body); return; }
        toast.error(body?.error === 'read_only' ? refusalWords('read_only', body.detail) : refusalWords('failed'));
      } catch {
        if (live) toast.error(refusalWords('failed'));
      }
      if (live) onClose();
    })();
    return () => { live = false; };
    // Read once per review: the disk a review opened on does not change under it.
  }, [disk.gameId, disk.diskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The destination: the folder the drop landed in, by the label collectDirectories gives it ("/Docs/Sub").
  const destinationBlock = useMemo(() => {
    if (!data) return null;
    return collectDirectories(data.entries).find((d) => d.label === `/${folder}`)?.block ?? data.rootBlock;
  }, [data, folder]);
  const incoming = useMemo(() => (destinationBlock === null ? undefined : { items, destinationBlock }), [items, destinationBlock]);

  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onClose(); }} width={620} testId="files-drop-review"
           closeTestId="files-drop-review-close" title={`Add files to ${placeName(disk)}`} dismissible
           subtitle="Check the names before they are written. Every change is saved as a new version."
           footer={(
             <div className="flex w-full items-center justify-end">
               <Button variant="outline" onClick={onClose} data-testid="files-drop-review-cancel">Close</Button>
             </div>
           )}>
      {/* Drops inside the review belong to it: they must not reach the manager's own "Open a disk" answer. */}
      <div className="px-6 py-5" onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        {data && incoming ? (
          <FileEditProvider diskId={disk.diskId} tosecName={null} rootBlock={data.rootBlock} onWritten={onWritten}
                            disabled={data.disabled ? { reason: 'bitmap-untrusted', message: data.disabled } : null}>
            <DropStaging filesystem={data.filesystem} intl={data.intl} existingNamesByDir={data.existingNamesByDir}
                         freeBlocks={data.freeBlocks} entries={data.entries} freeBytes={data.freeBytes}
                         volumeName={data.volumeName} incoming={incoming} />
          </FileEditProvider>
        ) : (
          <p data-testid="files-drop-review-loading" className="text-[13px]" style={{ color: 'var(--muted)' }}>Reading the disk…</p>
        )}
      </div>
    </Modal>
  );
}
