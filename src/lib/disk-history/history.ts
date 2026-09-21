import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { diskVersions } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { readVolume } from '@/lib/adffs';
import { materialise, HistoryError, type VersionKind } from './chain';
import { loadEntries } from './store';
import { diffTrees, sectorSummary, type TreeChange } from './diff';

/**
 * The list a page renders: every version of a disk, newest first, with what
 * changed at each step, as files.
 *
 * THE REQUIREMENT THIS SERVES is timeline browsing (write-back spec §4, the
 * time machine). loadEntries gives the chain materialise() needs; this adds
 * the metadata a page wants to show (who made the change, when, from what)
 * and the diff between consecutive versions.
 *
 * Cost: each version's complete image is up to 880 KB, and reconstructing one
 * walks its delta chain. This walks the chain OLDEST TO NEWEST, materialising
 * each version exactly once and keeping only the previous version's tree in
 * memory to diff against -- never the whole history's images at once, and
 * never the same version's bytes twice.
 */

export type VersionSource = 'original' | 'browser' | 'amiga' | 'rewind';

export interface HistoryVersion {
  seq: number;
  kind: VersionKind;
  source: VersionSource;
  /** "Amiga: Bench board", "Edited in browser", "Restored to version 3", "As uploaded". */
  label: string;
  createdAt: Date;
  imageSha256: string;
  sectorCount: number;
  rewindOf: number | null;
  /** Empty when nothing changed as files, or when neither side has a filesystem. */
  changes: TreeChange[];
  /** Set instead of `changes` when a tree could not be read: "12 sectors changed". */
  sectorNote: string | null;
  isHead: boolean;
}

interface VersionMeta {
  seq: number;
  source: VersionSource;
  deviceId: string | null;
  userId: string | null;
  rewindOf: number | null;
  sectorCount: number;
  createdAt: Date;
}

/** The columns loadEntries doesn't select: everything a page wants to show. */
async function loadMeta(diskId: string): Promise<Map<number, VersionMeta>> {
  const rows = await getDb()
    .select({
      seq: diskVersions.seq,
      source: diskVersions.source,
      deviceId: diskVersions.deviceId,
      userId: diskVersions.userId,
      rewindOf: diskVersions.rewindOf,
      sectorCount: diskVersions.sectorCount,
      createdAt: diskVersions.createdAt,
    })
    .from(diskVersions)
    .where(eq(diskVersions.diskId, diskId))
    .orderBy(asc(diskVersions.seq));

  return new Map(rows.map((r) => [r.seq, { ...r, source: r.source as VersionSource }]));
}

function labelFor(meta: VersionMeta, deviceNames: ReadonlyMap<string, string>): string {
  switch (meta.source) {
    case 'original': return 'As uploaded';
    case 'browser': return 'Edited in browser';
    case 'rewind': return `Restored to version ${meta.rewindOf}`;
    case 'amiga': {
      const name = meta.deviceId != null ? deviceNames.get(meta.deviceId) : undefined;
      return name ? `Amiga: ${name}` : 'Amiga';
    }
    default: {
      const exhaustive: never = meta.source;
      return exhaustive;
    }
  }
}

/**
 * Every version of `diskId`, newest first, each with its file-level changes
 * from the version before it.
 *
 * `deviceNames` maps device id to name so this does no queries of its own
 * beyond `loadEntries` and the metadata read above -- never one query per
 * version.
 *
 * `materialise` can throw `HistoryError` (a broken chain). Left to propagate:
 * the page decides what to show for a broken history, and swallowing it here
 * would hide a real fault as an empty list.
 */
export async function loadHistory(
  diskId: string, deviceNames: ReadonlyMap<string, string>,
): Promise<HistoryVersion[]> {
  const [entries, metaBySeq] = await Promise.all([loadEntries(diskId), loadMeta(diskId)]);
  const read = (sha256: string) => diskStore.read(sha256);

  const results: HistoryVersion[] = [];
  // The previous version's tree only -- never more than one image's worth of
  // state alive at a time, however long the history.
  let prevVolume: ReturnType<typeof readVolume> | null = null;

  for (const entry of entries) {
    const meta = metaBySeq.get(entry.seq);
    if (!meta) throw new HistoryError(`no metadata recorded for version ${entry.seq}`);

    const image = await materialise(entries, entry.seq, read);
    const volume = readVolume(image);

    let changes: TreeChange[] = [];
    let sectorNote: string | null = null;

    if (prevVolume !== null) {
      if (!prevVolume.ok || !volume.ok) {
        sectorNote = sectorSummary(meta.sectorCount);
      } else {
        changes = diffTrees(prevVolume.root, volume.root);
      }
    }

    results.push({
      seq: entry.seq,
      kind: entry.kind,
      source: meta.source,
      label: labelFor(meta, deviceNames),
      createdAt: meta.createdAt,
      imageSha256: entry.imageSha256,
      sectorCount: meta.sectorCount,
      rewindOf: meta.rewindOf,
      changes,
      sectorNote,
      isHead: false,
    });

    prevVolume = volume;
  }

  if (results.length > 0) results[results.length - 1].isHead = true;

  return results.reverse();
}
