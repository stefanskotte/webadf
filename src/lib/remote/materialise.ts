// A remote disk made mountable (spec §4.2 Mount / Send to Amiga). SERVER ONLY.
//
// The share API has no single-disk route, so the caller passes the title. Every call re-asks the owner, uncached
// (Review Focus 1): the title's disk list says whether the disk is still in scope and what its bytes are now. Then a
// HIDDEN games/disks pair (src/lib/remote-hidden.ts) holds those bytes with an entitlement for this org, so the
// ordinary mount, send, write-back and history paths work unchanged. An untouched hidden row follows the owner's
// sha256; one that took its first write (D2, recordVersion) is the person's own disk and is never refreshed.
import { createHash } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { atomic } from '@/db/atomic';
import { getDb } from '@/db';
import { blobs, disks, entitlements, games, type ImageFormat } from '@/db/schema/catalog';
import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { releaseEntitlements } from '@/lib/disk-delete';
import { isServable } from '@/lib/disk-format';
import { inspectHfe } from '@/lib/hfe/inspect';
import { stableId } from '@/lib/ingest';
import type { ShareFailure } from '@/lib/share/client';
import type { ShareDisk, ShareTitleDetail } from '@/lib/share/types';
import { diskStore } from '@/lib/storage';
import { makeSortTitle } from '@/lib/tosec';
import { remoteLibraries } from '@/db/schema/sharing';
import { clientFor, isFkViolation, noteRemoteResult, prepareRemote, purgeHidden, type RemoteDeps } from './store';

export type MaterialiseResult =
  | { ok: true; diskId: string }
  | { ok: false; reason: 'not_shared' | 'ended' | 'unreachable' | 'too_large' | 'mismatch' | 'protocol' | 'bad_response' | 'token_unreadable' };

type Reason = Extract<MaterialiseResult, { ok: false }>['reason'];

const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_TEXT = 300;

/** The hidden rows' ids (Task 6): never the ingest 'game'/'disk' ids, so they cannot collide with a local row. */
export const hiddenGameId = (orgId: string, remoteLibraryId: string, remoteTitleId: string) =>
  stableId('rgame', orgId, remoteLibraryId, remoteTitleId);
export const hiddenDiskId = (orgId: string, remoteLibraryId: string, remoteDiskId: string) =>
  stableId('rdisk', orgId, remoteLibraryId, remoteDiskId);

function reasonOf(f: ShareFailure): Reason {
  switch (f) {
    case 'not_found': return 'not_shared';
    case 'ended': return 'ended';
    case 'unreachable':
    case 'rate_limited': return 'unreachable';
    case 'too_large': return 'too_large';
    case 'token_unreadable': return 'token_unreadable';
    case 'protocol': return 'protocol';
    default: return 'bad_response';
  }
}

const fail = (reason: Reason): MaterialiseResult => ({ ok: false, reason });

function text(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, MAX_TEXT);
  return s || fallback;
}

/** The owner's disk entry, checked as far as we rely on it; null when it is not a disk we can hold. */
function validDisk(d: unknown): ShareDisk | null {
  if (!d || typeof d !== 'object') return null;
  const x = d as ShareDisk;
  if (typeof x.id !== 'string' || typeof x.sha256 !== 'string' || !SHA_RE.test(x.sha256)) return null;
  if (!Number.isInteger(x.diskNo) || x.diskNo < 1 || x.diskNo > 999) return null;
  if (!Number.isInteger(x.sizeBytes) || x.sizeBytes <= 0) return null;
  if (x.imageFormat !== 'adf' && x.imageFormat !== 'hfe') return null;
  return x;
}

export async function materialiseRemoteDisk(
  orgId: string, remoteLibraryId: string, remoteTitleId: string, remoteDiskId: string, deps?: RemoteDeps,
): Promise<MaterialiseResult> {
  const p = await prepareRemote(orgId, remoteLibraryId);
  if (!p.ok) return fail(p.result.ok ? 'protocol' : (p.result.failure === 'not_found' ? 'not_shared' : reasonOf(p.result.failure)));
  const client = clientFor(deps);

  // Fresh, never the listing cache: a title taken out of scope a second ago must not mount.
  const listing = await client.getJson<ShareTitleDetail>(p.target, `titles/${encodeURIComponent(remoteTitleId)}`);
  await noteRemoteResult(orgId, remoteLibraryId, listing);
  if (!listing.ok) return fail(reasonOf(listing.failure));
  const detail = listing.value;
  if (!detail || typeof detail !== 'object' || !detail.title || !Array.isArray(detail.disks)) return fail('bad_response');
  const entry = detail.disks.find((d) => d && (d as ShareDisk).id === remoteDiskId);
  if (!entry) return fail('not_shared');
  const d = validDisk(entry);
  if (!d) return fail('bad_response');
  if (d.sizeBytes > MAX_DISK_BYTES) return fail('too_large');

  const db = getDb();
  const gameId = hiddenGameId(orgId, remoteLibraryId, remoteTitleId);
  const diskId = hiddenDiskId(orgId, remoteLibraryId, remoteDiskId);

  const [existing] = await db.select({ id: disks.id, sha256: disks.sha256, remoteLibraryId: disks.remoteLibraryId })
    .from(disks).where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  // Unchanged at the owner: the row we hold is current.
  if (existing && existing.remoteLibraryId === remoteLibraryId && existing.sha256 === d.sha256) return { ok: true, diskId };
  // The person's own copy now (D2: it took a write). Never refreshed from the owner; it is what this disk mounts as.
  if (existing && existing.remoteLibraryId === null) return { ok: true, diskId };

  const got = await client.getBytes(p.target, `disks/${encodeURIComponent(remoteDiskId)}/bytes`);
  await noteRemoteResult(orgId, remoteLibraryId, got);
  if (!got.ok) return fail(reasonOf(got.failure));
  const bytes = got.value;
  if (bytes.byteLength > MAX_DISK_BYTES) return fail('too_large');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // The bytes, their ETag and the listing must all agree: otherwise the disk changed mid-flight or something
  // between us and the owner altered it. Nothing is stored.
  if (sha256 !== got.etag || sha256 !== d.sha256 || bytes.byteLength !== d.sizeBytes) return fail('mismatch');

  let hfe: { extractable: boolean; extractReason: string | null; maxTrackBits: number } | null = null;
  if (d.imageFormat === 'hfe') {
    const h = inspectHfe(bytes);
    if (!h.ok) return fail('mismatch');
    hfe = { extractable: h.extractable, extractReason: h.extractReason, maxTrackBits: h.maxTrackBits };
  } else if (!isServable({ imageFormat: 'adf', sizeBytes: bytes.byteLength })) {
    return fail('mismatch');
  }

  await diskStore.put(sha256, bytes);

  const title = text(detail.title.title, 'Untitled');
  const name = text(d.name, `Disk ${d.diskNo}`);
  const y = detail.title.year;
  const year = typeof y === 'number' && Number.isInteger(y) && y >= 1900 && y <= 2100 ? y : null;
  const publisher = typeof detail.title.publisher === 'string' ? text(detail.title.publisher, '') || null : null;
  const diskFields = {
    sha256, sizeBytes: bytes.byteLength, diskNo: d.diskNo, label: name, isBoot: d.diskNo === 1,
    imageFormat: (d.imageFormat === 'hfe' ? 'hfe' : 'adf') as ImageFormat,
    // An ADF is writable, so the Amiga's saves reach write-back (and D2 makes it the person's disk). An HFE is
    // always protected, as every HFE row is.
    writeProtected: hfe !== null,
    extractable: hfe?.extractable ?? null, extractReason: hfe?.extractReason ?? null, maxTrackBits: hfe?.maxTrackBits ?? null,
  };

  try {
    await atomic((tx) => [
      tx.insert(blobs).values({ sha256, sizeBytes: bytes.byteLength, storageKey: diskStore.storageKey(sha256) }).onConflictDoNothing(),
      tx.insert(entitlements).values({ orgId, sha256, sourceFilename: `${name}.${d.imageFormat}` }).onConflictDoNothing(),
      // The stand-in follows the owner's title. It stays hidden for good: a disk's first write (D2) moves the disk
      // into the person's own copy of the title (ownCopyGameId) instead of making this game local.
      tx.insert(games).values({
        id: gameId, orgId, title, sortTitle: makeSortTitle(title), year, publisher,
        remoteLibraryId, remoteTitleId, metadataSource: 'remote',
      }).onConflictDoUpdate({
        target: games.id,
        set: { title, sortTitle: makeSortTitle(title), year, publisher },
        setWhere: isNotNull(games.remoteLibraryId),
      }),
      tx.insert(disks).values({
        id: diskId, gameId, orgId, ...diskFields, remoteLibraryId, remoteDiskId,
      }).onConflictDoUpdate({
        target: disks.id,
        set: diskFields,
        // Only an untouched hidden row follows the owner (D2).
        setWhere: eq(disks.remoteLibraryId, remoteLibraryId),
      }),
    ]);
  } catch (e) {
    // A Remove deleted the library while the bytes were on their way: the FK (no cascade) refused the rows.
    if (isFkViolation(e)) return fail('ended');
    throw e;
  }

  // A revoke (endRemoteLibrary) that purged while the bytes were on their way would otherwise leave this new row
  // mountable in an ended library that nothing purges again. Checked after the commit, so either the purge saw
  // the row or this check sees 'ended'.
  const [lib] = await db.select({ status: remoteLibraries.status }).from(remoteLibraries)
    .where(and(eq(remoteLibraries.id, remoteLibraryId), eq(remoteLibraries.orgId, orgId))).limit(1);
  if (!lib || lib.status === 'ended') {
    await purgeHidden(orgId, remoteLibraryId);
    return fail('ended');
  }

  // The previous bytes of a refreshed row: this org no longer needs them unless another disk (or history) does.
  if (existing && existing.sha256 !== sha256) await releaseEntitlements(orgId, [existing.sha256]);
  return { ok: true, diskId };
}
