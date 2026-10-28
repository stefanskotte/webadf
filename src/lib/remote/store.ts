// The recipient's remote libraries (spec §4.1-4.4). SERVER ONLY.
//
// A remote library is a claimed share: the owner's origin, its TLS pin, the token (sealed, crypto.ts) and a status.
// Every call to the owner goes through here so the status follows what the owner answers (spec §4.3):
//   ok answer        -> status 'ok', last_ok_at now
//   401 ('ended')    -> endRemoteLibrary: status 'ended' and every hidden row purged (the owner revoked)
//   network failure  -> status 'unreachable' (retried on the next visit)
//   409 ('protocol') -> status 'protocol'
//   429              -> status left alone (the owner is there, just busy)
// An 'ended' library is never called again: its token is dead. It stays listed until removed.
//
// Hidden rows (src/lib/remote-hidden.ts) are the games/disks pairs materialise.ts makes so a remote disk can be
// mounted. purgeHidden ejects them from every drive BEFORE deleting them (Review Focus 3): a disk row that simply
// vanishes tells no board, because the board wakes only on a version bump.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, notExists, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { organization } from '@/db/schema/auth';
import { disks, games } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { remoteLibraries } from '@/db/schema/sharing';
import { clearDesired } from '@/lib/mount';
import { ejectDf1Holders } from '@/lib/df1-store';
import { releaseEntitlements } from '@/lib/disk-delete';
import { shareClient, type ShareClient, type ShareResult, type ShareTarget } from '@/lib/share/client';
import { parseShareLink } from '@/lib/share/link';
import { publicOrigin } from '@/lib/share/instance';
import { cached, forgetCached } from './cache';
import { openToken, sealToken } from './crypto';

export type RemoteStatus = 'ok' | 'unreachable' | 'ended' | 'protocol';

export type RemoteLibraryRow = {
  id: string;
  name: string;
  baseUrl: string;
  status: RemoteStatus;
  lastOkAt: Date | null;
  lastError: string | null;
  addedAt: Date;
};

export type RemoteDeps = { client?: ShareClient };

export type AddRemoteResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'bad_link' | 'invalid_or_used' | 'unreachable' | 'protocol' | 'already_added'; detail?: string };

/** Listings are cached 60 s per (remote library, request) (global constraints). */
export const LISTING_CACHE_MS = 60_000;

/** Longest library name kept from an owner (it is the owner's text, shown in our UI). */
const MAX_NAME = 200;

let clientForTests: ShareClient | null = null;

/** Tests only (Ruling P3): every call in this module and materialise.ts uses `c` until reset with null. */
export function setShareClientForTests(c: ShareClient | null): void {
  clientForTests = c;
}

/** The client a call uses: the caller's, else the test override, else the real guarded one. */
export function clientFor(deps?: RemoteDeps): ShareClient {
  return deps?.client ?? clientForTests ?? shareClient();
}

const rowColumns = {
  id: remoteLibraries.id, name: remoteLibraries.name, baseUrl: remoteLibraries.baseUrl,
  status: remoteLibraries.status, lastOkAt: remoteLibraries.lastOkAt, lastError: remoteLibraries.lastError,
  addedAt: remoteLibraries.addedAt,
};

function cleanName(raw: string, fallback: string): string {
  // The owner's text: control characters out, one line, bounded.
  const s = raw.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, MAX_NAME);
  return s || fallback;
}

async function orgName(orgId: string): Promise<string> {
  const [row] = await getDb().select({ name: organization.name }).from(organization)
    .where(eq(organization.id, orgId)).limit(1);
  return row?.name?.trim() || 'WebFloppy';
}

/** Add a library from a pasted share link: parse, claim, store the sealed token (spec §4.2 Add). */
export async function addRemoteLibrary(
  orgId: string, userId: string, rawLink: string, deps?: RemoteDeps,
): Promise<AddRemoteResult> {
  const link = parseShareLink(rawLink);
  if (!link) return { ok: false, reason: 'bad_link' };

  const db = getDb();
  const [dup] = await db.select({ id: remoteLibraries.id }).from(remoteLibraries)
    .where(and(eq(remoteLibraries.orgId, orgId), eq(remoteLibraries.baseUrl, link.origin), eq(remoteLibraries.status, 'ok')))
    .limit(1);
  if (dup) return { ok: false, reason: 'already_added' };

  const target: ShareTarget = { origin: link.origin, pin: link.pin };
  const r = await clientFor(deps).claim(target, link.code, { instanceUrl: publicOrigin(), instanceName: await orgName(orgId) });
  if (!r.ok) {
    switch (r.failure) {
      case 'invalid_or_used':
      case 'not_found':
      case 'ended':
        return { ok: false, reason: 'invalid_or_used' };
      case 'unreachable':
      case 'rate_limited':
        return { ok: false, reason: 'unreachable', detail: r.failure === 'rate_limited' ? 'rate_limited' : r.detail };
      default:
        // 'protocol', and an answer that is not a share API at all ('bad_response', 'too_large').
        return { ok: false, reason: 'protocol', detail: r.failure === 'protocol' ? r.detail : r.failure };
    }
  }

  const id = randomUUID();
  await db.insert(remoteLibraries).values({
    id, orgId, baseUrl: link.origin, tokenEnc: sealToken(r.value.token), tlsPin: link.pin,
    name: cleanName(r.value.library.name, new URL(link.origin).host),
    status: 'ok', lastOkAt: new Date(), lastError: null, addedBy: userId,
  });
  return { ok: true, id };
}

export async function listRemoteLibraries(orgId: string): Promise<RemoteLibraryRow[]> {
  const rows = await getDb().select(rowColumns).from(remoteLibraries)
    .where(eq(remoteLibraries.orgId, orgId))
    .orderBy(asc(remoteLibraries.addedAt), asc(remoteLibraries.id));
  return rows as RemoteLibraryRow[];
}

/**
 * The library and what to call it with. Null when it is not this org's. `target.token` is absent when the sealed
 * token cannot be opened (BETTER_AUTH_SECRET changed): remoteCall then ends the library.
 */
export async function getRemoteTarget(orgId: string, id: string): Promise<{ row: RemoteLibraryRow; target: ShareTarget } | null> {
  const [r] = await getDb().select({ ...rowColumns, tokenEnc: remoteLibraries.tokenEnc, tlsPin: remoteLibraries.tlsPin })
    .from(remoteLibraries)
    .where(and(eq(remoteLibraries.id, id), eq(remoteLibraries.orgId, orgId)))
    .limit(1);
  if (!r) return null;
  const { tokenEnc, tlsPin, ...row } = r;
  let token: string | undefined;
  try { token = openToken(tokenEnc); } catch { token = undefined; }
  return { row: row as RemoteLibraryRow, target: token ? { origin: row.baseUrl, pin: tlsPin, token } : { origin: row.baseUrl, pin: tlsPin } };
}

/**
 * Record what the owner answered (spec §4.3). Never moves an 'ended' library back: its token is dead, and a
 * stale in-flight answer must not resurrect it.
 */
export async function noteRemoteResult(orgId: string, id: string, r: ShareResult<unknown>): Promise<void> {
  const where = and(eq(remoteLibraries.id, id), eq(remoteLibraries.orgId, orgId), ne(remoteLibraries.status, 'ended'));
  const db = getDb();
  if (r.ok || r.failure === 'not_found') {
    // A 404 is the owner answering properly about one item: the library itself is fine.
    await db.update(remoteLibraries).set({ status: 'ok', lastOkAt: new Date(), lastError: null }).where(where);
    return;
  }
  const lastError = r.detail ? `${r.failure}: ${r.detail}`.slice(0, 200) : r.failure;
  switch (r.failure) {
    case 'ended':
      await endRemoteLibrary(orgId, id);
      return;
    case 'unreachable':
      await db.update(remoteLibraries).set({ status: 'unreachable', lastError }).where(where);
      return;
    case 'protocol':
      await db.update(remoteLibraries).set({ status: 'protocol', lastError }).where(where);
      return;
    case 'rate_limited':
      return;
    default:
      // 'bad_response', 'too_large', 'invalid_or_used': worth a note, not a status.
      await db.update(remoteLibraries).set({ lastError }).where(where);
  }
}

type Prepared = { ok: true; target: ShareTarget } | { ok: false; result: ShareResult<never> };

/** The target for a call, or the answer without calling: unknown library 404, an ended one 'ended'. */
export async function prepareRemote(orgId: string, id: string): Promise<Prepared> {
  const t = await getRemoteTarget(orgId, id);
  if (!t) return { ok: false, result: { ok: false, failure: 'not_found' } };
  if (t.row.status === 'ended') return { ok: false, result: { ok: false, failure: 'ended' } };
  if (!t.target.token) {
    await endRemoteLibrary(orgId, id, 'token_unreadable');
    return { ok: false, result: { ok: false, failure: 'ended', detail: 'token_unreadable' } };
  }
  return { ok: true, target: t.target };
}

const cacheKey = (id: string, path: string) => `${id} ${path}`;

/** GET a listing from the owner, through the 60 s cache; the status follows the answer (only fresh ones count). */
export async function remoteCall<T>(orgId: string, id: string, path: string, deps?: RemoteDeps): Promise<ShareResult<T>> {
  const p = await prepareRemote(orgId, id);
  if (!p.ok) return p.result;
  let fresh = false;
  const r = await cached(cacheKey(id, path), LISTING_CACHE_MS, () => {
    fresh = true;
    return clientFor(deps).getJson<T>(p.target, path);
  });
  if (fresh) await noteRemoteResult(orgId, id, r);
  return r;
}

/** The owner revoked (any 401), or the token is unusable: status 'ended', every hidden row ejected and deleted. */
export async function endRemoteLibrary(orgId: string, id: string, reason = 'ended'): Promise<void> {
  await getDb().update(remoteLibraries).set({ status: 'ended', lastError: reason })
    .where(and(eq(remoteLibraries.id, id), eq(remoteLibraries.orgId, orgId)));
  forgetCached(cacheKey(id, ''));
  await purgeHidden(orgId, id);
}

/** Remove (spec §4.4): purge the hidden rows, then the library. False when it is not this org's. */
export async function removeRemoteLibrary(orgId: string, id: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select({ id: remoteLibraries.id }).from(remoteLibraries)
    .where(and(eq(remoteLibraries.id, id), eq(remoteLibraries.orgId, orgId))).limit(1);
  if (!row) return false;
  forgetCached(cacheKey(id, ''));
  // A mount racing this can materialise a new hidden row between the purge and the delete; the FK (no cascade)
  // then refuses the delete, and the purge runs again.
  for (let attempt = 0; ; attempt++) {
    await purgeHidden(orgId, id);
    try {
      await db.delete(remoteLibraries).where(and(eq(remoteLibraries.id, id), eq(remoteLibraries.orgId, orgId)));
      return true;
    } catch (e) {
      if (attempt >= 3 || !isFkViolation(e)) throw e;
    }
  }
}

function isFkViolation(err: unknown): boolean {
  for (const e of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (e && typeof e === 'object' && (e as { code?: unknown }).code === '23503') return true;
  }
  return false;
}

/**
 * Eject, then delete, every hidden row of one remote library (spec §4.4, Review Focus 3). Disks that became local
 * at their first write (D2) have no remote_library_id and are untouched. Entitlements go unless the org still
 * holds those bytes in another disk (or its disk history); blobs are left to the weekly GC.
 */
export async function purgeHidden(orgId: string, remoteLibraryId: string): Promise<{ ejected: number; deleted: number }> {
  const db = getDb();
  const ejectedDevices = new Set<string>();
  let deleted = 0;

  // Rounds, because a mount racing the purge can materialise one more hidden disk; each round ejects exactly the
  // rows it then deletes, so no row is ever deleted without its eject.
  for (let round = 0; round < 5; round++) {
    const hidden = await db.select({ id: disks.id, sha256: disks.sha256 }).from(disks)
      .where(and(eq(disks.orgId, orgId), eq(disks.remoteLibraryId, remoteLibraryId)));
    if (hidden.length === 0) break;
    const ids = hidden.map((d) => d.id);

    // DF0: any board that wants or holds one of them is told to eject (clearDesired bumps the version).
    const holders = await db.select({ id: devices.id }).from(devices)
      .where(and(eq(devices.orgId, orgId), or(inArray(devices.desiredDiskId, ids), inArray(devices.mountedDiskId, ids))));
    for (const h of holders) {
      await clearDesired(orgId, h.id);
      ejectedDevices.add(h.id);
    }
    // DF1: picks let go, with the cursor moved.
    const df1 = await db.select({ id: devices.id }).from(devices)
      .where(and(eq(devices.orgId, orgId), inArray(devices.df1DiskId, ids)));
    await ejectDf1Holders(orgId, ids);
    for (const d of df1) ejectedDevices.add(d.id);
    // "Re-insert last disk" must not offer a disk that is about to be gone (clearDesired may just have set it).
    await db.update(devices).set({ lastDiskId: null })
      .where(and(eq(devices.orgId, orgId), inArray(devices.lastDiskId, ids)));

    // Only rows still hidden: one that took its first write meanwhile (D2) is the person's own disk now.
    const gone = await db.delete(disks)
      .where(and(eq(disks.orgId, orgId), eq(disks.remoteLibraryId, remoteLibraryId), inArray(disks.id, ids)))
      .returning({ sha256: disks.sha256 });
    deleted += gone.length;
    await releaseEntitlements(orgId, [...new Set(gone.map((g) => g.sha256))]);
  }

  // Hidden games with no disk left. A hidden game still holding a disk would mean a disk materialised after the
  // last round; it stays, and the caller's next purge takes it.
  await db.delete(games).where(and(
    eq(games.orgId, orgId), eq(games.remoteLibraryId, remoteLibraryId),
    notExists(db.select({ one: sql`1` }).from(disks).where(eq(disks.gameId, games.id))),
  ));

  return { ejected: ejectedDevices.size, deleted };
}
