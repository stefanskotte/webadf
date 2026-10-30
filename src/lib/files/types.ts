// Shared Files types (spec 2026-10-29). Client-safe: types only.
import type { MountChoice } from '@/lib/mount-choice';
import type { HistoryVersion } from '@/lib/disk-history/history';
import type { DiskColor } from '@/lib/disk-icon';
import type { AdfEntry } from '@/lib/adffs';
import type { ExistingEntry } from '@/lib/staging';
/**
 * 'archive': a .lha/.lzh/.zip in STASH:, a file that also opens as a read-only folder. 'board': a board under NET:.
 * 'collection': a Library collection under LIBRARY:, a folder of titles (Files 2). 'volume': a volume of a board's Amiga
 * under NET:/<board> (NET: volumes, spec 2026-10-30), opened like a folder.
 */
export type EntryKind = 'title' | 'disk' | 'dir' | 'file' | 'archive' | 'board' | 'collection' | 'volume';
export type FsEntry = {
  name: string; kind: EntryKind; path: string;
  size: number | null; date: string | null; protection: string | null; comment: string | null;
  marks: string[];
  /** The version that added this entry to its disk ("new in vN", from the disk's History); absent for none. */
  addedIn?: number;
  /** A STASH: file still arriving from the Amiga: the bytes it holds so far (a pane tells a stopped one by it). */
  received?: number;
  /** A folder inside a disk: everything under it, at any depth (what deleting it removes as well). */
  inside?: { files: number; folders: number };
  /** The Size cell's words for a row without bytes: a collection's "12 titles". */
  sizeText?: string;
};
export type DiskInfo = {
  diskId: string; gameId: string; title: string; label: string; filesystem: 'OFS' | 'FFS' | null; hd: boolean;
  usedBytes: number | null; freeBytes: number | null; totalBytes: number | null;
  holder: string | null; imageFormat: 'adf' | 'hfe'; volumeName: string | null; sha256: string;
  /** The volume's international mode: which case fold its names compare under (sameName). */
  intl: boolean;
  /**
   * The TOSEC name this disk is recognised as, ONLY when its blob really matched (`blobs.matchState = 'matched'`), not
   * merely `disks.tosecName`, which also holds the uploaded filename: editing drops that identity (D-W-3).
   */
  tosecName: string | null;
};
export type Crumb = { label: string; path: string };
export type Listing = {
  path: string; crumbs: Crumb[]; entries: FsEntry[];
  writable: boolean; readOnlyReason: string | null; disk: DiskInfo | null; meta: string;
  /** NET:/<board> only: what counts against the board's 32 files / 16 MB now (a drop checks it before uploading). */
  queue?: { deviceId: string; files: number; bytes: number };
  /**
   * LIBRARY: only: where the pane is (Files 2): the root, a collection, a title's disks, or inside a disk. At the root
   * the collection rows come first, in the Library's collection order (sortKey) as listed: a pane keeps them in this
   * order whatever its column sort, and sorts only the titles after them.
   */
  library?: { level: 'root' | 'collection' | 'title' | 'disk'; collectionId: string | null };
  /** Inside a disk: the disk's own path, with its collection prefix ("new in vN" and the drop folder read under it). */
  diskBase?: string | null;
  /**
   * NET:/<board> and its volumes (spec 2026-10-30 §5): the board, the volume and Amiga path shown (null at the board),
   * when the remembered answer was read (null when nothing was read), whether Transfer cut it at 1000 entries, and
   * `browse`: null when the board can be browsed, else the words why not.
   */
  net?: { board: string; boardName: string; volume: string | null; amigaPath: string | null; readAt: number | null; cut: boolean; browse: string | null };
};
export type RefusalCode =
  | 'not_found' | 'read_only' | 'mounted' | 'disk_full' | 'name_exists' | 'bad_name' | 'comment_too_long'
  | 'cycle' | 'no_filesystem' | 'hfe_read_only' | 'conflict' | 'unsupported' | 'blob_unavailable' | 'failed'
  | 'stash_full' | 'too_large' | 'archive_unreadable' | 'not_a_disk_image' | 'queue_full';
export type Refusal = { code: RefusalCode; detail?: string };
/**
 * What a pane inside a disk shows in its disk strip besides the listing (disk-strip-data.ts): the Mount choices, the
 * History (with `headSeq`, the current version, null for a disk never changed), the title's disk colour, and for a
 * person's own copy of a shared library's title the notice saying whose it was (`copiedFrom`, the words; else null).
 */
export type StripData = {
  diskId: string; choices: MountChoice[]; history: HistoryVersion[]; historyUnavailable: boolean;
  headSeq: number | null; color: DiskColor; copiedFrom: string | null;
  /**
   * The disk as the database knows it, without reading its image (no filesystem, volume name or usage): what the
   * strip draws when the pane's listing could not read the image, so History and Restore are still there to reach.
   */
  info: DiskInfo;
};
/**
 * A writable disk as the drop review (drop-staging.tsx) needs it (Task 9b, /api/files/drop-review): its whole tree,
 * for the Destination list and the clash checks, and its free space. `disabled` says why nothing can be written though
 * the disk is not read-only (its allocation bitmap cannot be trusted), else null.
 */
export type DropReviewData = {
  filesystem: 'OFS' | 'FFS'; intl: boolean; rootBlock: number; volumeName: string;
  entries: AdfEntry[]; existingNamesByDir: Record<string, ExistingEntry[]>;
  freeBlocks: number; freeBytes: number | null; disabled: string | null;
};
