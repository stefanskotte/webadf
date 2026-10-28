// Shared Files types (spec 2026-10-29). Client-safe: types only.
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
