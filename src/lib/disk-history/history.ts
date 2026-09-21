import { and, asc, eq } from 'drizzle-orm';
import { ADF_BYTES } from '@/lib/adfmfm';
import { getDb } from '@/db';
import { diskVersions } from '@/db/schema/disk-history';
import { diskStore } from '@/lib/storage';
import { readVolume } from '@/lib/adffs';
import { HistoryError, type VersionKind } from './chain';
import { applyDelta, decodeDelta } from './delta';
import { loadEntries } from './store';
import { diffTrees, sectorSummary, type TreeChange } from './diff';

/**
 * The list a page renders: every version of a disk, newest first, with what
 * changed at each step, as files.
 *
 * THE REQUIREMENT THIS SERVES is timeline browsing (write-back spec §4, the
 * time machine). loadEntries gives the chain of blobs; this adds the metadata
 * a page wants to show (who made the change, when, from what) and the diff
 * between consecutive versions.
 *
 * Cost: each version's complete image is up to 880 KB, and `chain.ts`'s
 * `materialise` reconstructs one by replaying from its nearest snapshot --
 * fine for fetching a single version, ruinous for walking a whole history,
 * where calling it once per version means an N-deep chain does its Nth
 * version's replay work again for every version after it (~N²/2 blob reads
 * and delta applies for an N-entry chain, not N). `materialise` is left
 * untouched -- other callers only ever want one version -- and this file
 * does its own single forward pass instead: OLDEST TO NEWEST, one blob read
 * per version (its own snapshot image or its own delta payload, never an
 * earlier version's), applying at most one delta onto the previous version's
 * RAW bytes. Only that previous version's raw image and parsed tree are ever
 * in memory -- never the whole history's images at once.
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
  /**
   * Empty when nothing changed as files, or when this version or the one
   * before it has no readable filesystem (see `sectorNote` -- either side
   * being unreadable is enough to fall back to it, not only both).
   */
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

/**
 * The columns loadEntries doesn't select: everything a page wants to show.
 *
 * Filtered by `orgId` as well as `diskId` -- defence in depth, NOT the
 * entitlement check. A disk's id is not a secret an org boundary needs to
 * hide, but a stray cross-org diskId here would otherwise read another
 * tenant's row metadata with nothing to stop it. The actual "is this caller
 * allowed to see this disk at all" decision is the `disks ⋈ entitlements`
 * join every read route already does before it gets anywhere near
 * `loadHistory` (see `applyDiskEdit` for the pattern) -- that check still
 * has to happen at the caller; this scoping only limits the blast radius of
 * a wrong diskId reaching this far.
 */
async function loadMeta(orgId: string, diskId: string): Promise<Map<number, VersionMeta>> {
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
    .where(and(eq(diskVersions.diskId, diskId), eq(diskVersions.orgId, orgId)))
    .orderBy(asc(diskVersions.seq));

  return new Map(rows.map((r) => [r.seq, { ...r, source: r.source as VersionSource }]));
}

function labelFor(meta: VersionMeta, deviceNames: ReadonlyMap<string, string>): string {
  switch (meta.source) {
    case 'original': return 'As uploaded';
    case 'browser': return 'Edited in browser';
    case 'rewind':
      return meta.rewindOf !== null ? `Restored to version ${meta.rewindOf}` : 'Restored';
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
 * Every version of `diskId` in org `orgId`, newest first, each with its
 * file-level changes from the version before it.
 *
 * `orgId` scopes the metadata read for defence in depth ONLY -- it is not
 * the entitlement check, and does not replace one. Callers must still do
 * their own `disks ⋈ entitlements` join before ever reaching for a diskId
 * (every read route already does this; see `loadMeta`'s comment for why
 * both exist).
 *
 * An empty array means this disk has no `disk_versions` rows yet -- an
 * upload nobody has edited, since version 0 is created lazily at the first
 * write (`store.ts`). That is a normal, common state, not an error: the
 * page's own "as uploaded" knowledge covers it without this function
 * inventing a version 0 that storage doesn't actually hold.
 *
 * `deviceNames` maps device id to name so this does no queries of its own
 * beyond `loadEntries` and the metadata read above -- never one query per
 * version.
 *
 * Can throw `HistoryError` (a broken chain, or a version whose blob or
 * metadata is missing). Left to propagate: the page decides what to show for
 * a broken history, and swallowing it here would hide a real fault as an
 * empty list.
 */
export async function loadHistory(
  orgId: string, diskId: string, deviceNames: ReadonlyMap<string, string>,
): Promise<HistoryVersion[]> {
  const [entries, metaBySeq] = await Promise.all([loadEntries(diskId), loadMeta(orgId, diskId)]);
  const read = (sha256: string) => diskStore.read(sha256);

  const results: HistoryVersion[] = [];
  // Only the previous version's RAW bytes and parsed tree are ever kept --
  // never the whole history's images at once, and never re-read to
  // reconstruct a later version (that is exactly the cost `materialise`
  // would re-pay for every version past the first snapshot).
  let prevRaw: Uint8Array | null = null;
  let prevVolume: ReturnType<typeof readVolume> | null = null;

  for (const entry of entries) {
    const meta = metaBySeq.get(entry.seq);
    if (!meta) throw new HistoryError(`no metadata recorded for version ${entry.seq}`);

    let image: Uint8Array;
    if (entry.kind === 'snapshot') {
      image = await read(entry.blobSha256);
      if (image.length !== ADF_BYTES) {
        throw new HistoryError(`snapshot ${entry.seq} is ${image.length} bytes, not a disk image`);
      }
    } else {
      if (!prevRaw) throw new HistoryError(`version ${entry.seq} has no snapshot to replay from`);
      image = applyDelta(prevRaw, decodeDelta(await read(entry.blobSha256)));
    }
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

    prevRaw = image;
    prevVolume = volume;
  }

  if (results.length > 0) results[results.length - 1].isHead = true;

  return results.reverse();
}
