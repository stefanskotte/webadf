// Shared Files types (spec 2026-10-29). Client-safe: types only.
import type { MountChoice } from '@/lib/mount-choice';
import type { HistoryVersion } from '@/lib/disk-history/history';
import type { DiskColor } from '@/lib/disk-icon';
export type EntryKind = 'title' | 'disk' | 'dir' | 'file';
export type FsEntry = {
  name: string; kind: EntryKind; path: string;
  size: number | null; date: string | null; protection: string | null; comment: string | null;
  marks: string[];
};
export type DiskInfo = {
  diskId: string; gameId: string; title: string; label: string; filesystem: 'OFS' | 'FFS' | null; hd: boolean;
  usedBytes: number | null; freeBytes: number | null; totalBytes: number | null;
  holder: string | null; imageFormat: 'adf' | 'hfe'; volumeName: string | null; sha256: string;
  /** The volume's international mode: which case fold its names compare under (sameName). */
  intl: boolean;
};
export type Crumb = { label: string; path: string };
export type Listing = {
  path: string; crumbs: Crumb[]; entries: FsEntry[];
  writable: boolean; readOnlyReason: string | null; disk: DiskInfo | null; meta: string;
};
export type RefusalCode =
  | 'not_found' | 'read_only' | 'mounted' | 'disk_full' | 'name_exists' | 'bad_name' | 'comment_too_long'
  | 'cycle' | 'no_filesystem' | 'hfe_read_only' | 'conflict' | 'unsupported' | 'blob_unavailable' | 'failed';
export type Refusal = { code: RefusalCode; detail?: string };
/**
 * What a pane inside a disk shows in its disk strip besides the listing (disk-strip-data.ts): the Mount choices, the
 * History (with `headSeq`, the current version, null for a disk never changed) and the title's disk colour.
 */
export type StripData = {
  diskId: string; choices: MountChoice[]; history: HistoryVersion[]; historyUnavailable: boolean;
  headSeq: number | null; color: DiskColor;
};
