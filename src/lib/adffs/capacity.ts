import { BLOCK_BYTES, HASH_TABLE_SIZE, OFS_DATA_BYTES } from './constants';
import type { Filesystem } from './boot';

export interface CostItem { kind: 'file' | 'dir'; sizeBytes: number }

export function blocksForFile(sizeBytes: number, fs: Filesystem): number {
  const perBlock = fs === 'OFS' ? OFS_DATA_BYTES : BLOCK_BYTES;
  const data = Math.max(1, Math.ceil(sizeBytes / perBlock));
  const ext = Math.max(0, Math.ceil((data - HASH_TABLE_SIZE) / HASH_TABLE_SIZE));
  return 1 + data + ext;
}

export function blocksForPlan(items: readonly CostItem[], fs: Filesystem): number {
  return items.reduce(
    (n, i) => n + (i.kind === 'dir' ? 1 : blocksForFile(i.sizeBytes, fs)),
    0,
  );
}
