// What the remote pages (src/app/(app)/remote/) read: the owner's listings through the 60 s cache (remoteCall), checked
// (wire.ts) before they render. SERVER ONLY. The pages call these directly, as the library page reads its own lib.
import type { ShareFailure } from '@/lib/share/client';
import type { ShareLibrary } from '@/lib/share/types';
import type { RemoteCardSummary } from '@/components/remote/remote-library-card';
import { hostOf, remotePaths } from './http';
import { getRemoteTarget, remoteCall, type RemoteLibraryRow } from './store';
import { checkLibrary } from './wire';

export type Loaded<T> = { ok: true; value: T } | { ok: false; failure: ShareFailure | 'protocol'; detail?: string };

/** GET one listing and check it. An answer that is not what the share API sends is 'bad_response' (http.ts too). */
export async function loadRemote<T>(orgId: string, id: string, path: string, check: (raw: unknown) => T | null): Promise<Loaded<T>> {
  const r = await remoteCall<unknown>(orgId, id, path);
  if (!r.ok) return { ok: false, failure: r.failure, detail: r.detail };
  const v = check(r.value);
  return v ? { ok: true, value: v } : { ok: false, failure: 'bad_response' };
}

/** This org's remote library and its host, or null (another org's id and an unknown id alike). */
export async function remoteLibrary(orgId: string, id: string): Promise<(RemoteLibraryRow & { host: string }) | null> {
  const t = await getRemoteTarget(orgId, id);
  return t ? { ...t.row, host: hostOf(t.row.baseUrl) } : null;
}

/** A /remote card's summary: the owner asked (cached), then the status as that answer left it. */
export async function cardSummary(orgId: string, id: string): Promise<RemoteCardSummary> {
  const r = await loadRemote<ShareLibrary>(orgId, id, remotePaths.library(), checkLibrary);
  const row = (await getRemoteTarget(orgId, id))?.row;
  const now = { status: row?.status ?? 'ended', lastOkAt: row?.lastOkAt ?? null, lastError: row?.lastError ?? null };
  return r.ok ? { ok: true, library: r.value, ...now } : { ok: false, failure: r.failure, detail: r.detail, ...now };
}
