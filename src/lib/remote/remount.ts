// Ruling R-6a: a local lever that mounts a disk BY ID -- "Re-insert last disk", the mount toast's Undo, both through
// POST /api/devices/[id]/mount -- must not mount a hidden remote disk without asking its owner again (Review Focus 1).
// A hidden disk is re-materialised first: still shared -> the mount goes ahead on the current bytes; otherwise the
// same answer the remote Mount gives ("No longer shared", "Access ended", ...). SERVER ONLY.
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { disks, games } from '@/db/schema/catalog';
import { remoteLibraries } from '@/db/schema/sharing';
import { hostOf, remoteFailure } from './http';
import { materialiseRemoteDisk } from './materialise';
import type { RemoteDeps } from './store';

export type HiddenCheck = { hidden: false } | { hidden: true; refusal: Response | null };

/** Local disk (or unknown id): `{hidden:false}`, the caller carries on. Hidden: re-asked; `refusal` is the answer when it may not mount. */
export async function recheckHidden(orgId: string, diskId: string, deps?: RemoteDeps): Promise<HiddenCheck> {
  const [r] = await getDb().select({
    lib: disks.remoteLibraryId, remoteDiskId: disks.remoteDiskId, remoteTitleId: games.remoteTitleId,
    baseUrl: remoteLibraries.baseUrl,
  }).from(disks)
    .leftJoin(games, and(eq(games.id, disks.gameId), eq(games.orgId, orgId)))
    .leftJoin(remoteLibraries, and(eq(remoteLibraries.id, disks.remoteLibraryId), eq(remoteLibraries.orgId, orgId)))
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  if (!r || r.lib === null) return { hidden: false };
  const host = hostOf(r.baseUrl ?? '');
  // A hidden disk whose title became the person's own (a sibling disk took the first write, D2) has lost the owner's
  // title id, and the share API names a disk only through its title: it cannot be re-asked, so it does not mount
  // from here. It still mounts from the remote library's pages, which know the title.
  if (!r.remoteDiskId || !r.remoteTitleId) return { hidden: true, refusal: remoteFailure('not_shared', host, { disk: true }) };
  const m = await materialiseRemoteDisk(orgId, r.lib, r.remoteTitleId, r.remoteDiskId, deps);
  if (!m.ok) return { hidden: true, refusal: remoteFailure(m.reason, host, { disk: true }) };
  return { hidden: true, refusal: null };
}
