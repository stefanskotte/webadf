// The drop review's server half (Files increment 1, Task 9b): a disk as drop-staging.tsx needs it. SERVER ONLY.
import { readUsage } from '@/lib/adffs';
import { existingNamesByDir } from '@/lib/staging';
import { loadDisk, readOnlyReasonOf, type FsCtx } from './library';
import type { FsPath } from './path';
import type { DropReviewData, RefusalCode } from './types';

/**
 * The disk a LIBRARY: path is inside, for a drop review: null when it is not a disk of this library (404), a refusal
 * when it cannot take files at all (a board holds it, an HFE, no filesystem). Throws BlobUnavailableError.
 */
export async function dropReviewData(ctx: FsCtx, p: FsPath):
  Promise<DropReviewData | { refused: RefusalCode; detail: string } | null> {
  const [gameId, diskId] = p.segments;
  if (p.device !== 'LIBRARY' || !gameId || !diskId) return null;
  const d = await loadDisk(ctx, gameId, diskId);
  if (!d) return null;
  const why = readOnlyReasonOf(d.info);
  if (why || !d.info.filesystem) return { refused: 'read_only', detail: why ?? 'no_filesystem' };
  const usage = readUsage(d.bytes);
  return {
    filesystem: d.info.filesystem, intl: d.intl, rootBlock: d.rootBlock, volumeName: d.info.volumeName ?? d.info.label,
    entries: d.root, existingNamesByDir: existingNamesByDir(d.root),
    freeBlocks: usage?.freeBlocks ?? 0, freeBytes: usage?.freeBytes ?? null,
    // The Browse page's words for the same state.
    disabled: usage ? null : "This disk's allocation bitmap can't be trusted, so blocks can't be safely allocated. Editing is disabled.",
  };
}
