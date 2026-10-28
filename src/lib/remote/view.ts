// The remote pages' addresses and shapes (library sharing spec §4.5). Pure and CLIENT-SAFE: no @/db.
import type { GameListItem } from '@/lib/queries';
import type { ShareTitle } from '@/lib/share/types';
import { parseShareLink } from '@/lib/share/link';

const enc = encodeURIComponent;

export type RemoteViewMode = 'grid' | 'table';

/** What /remote/[id] shows: a collection (null = all titles in scope), a search, a page (the owner's cursor), a view. */
export type RemoteView = { collection: string | null; q: string; cursor: string | null; view: RemoteViewMode };

/** Titles per page: the library's default page size, and the owner's default (share/listing.ts). */
export const REMOTE_PAGE_SIZE = 48;

/** The longest search sent on; the owner bounds it too. */
export const REMOTE_Q_MAX = 100;

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The view from the address. Repeated or junk parameters are absent; the search is trimmed and bounded. */
export function remoteView(sp: Record<string, string | string[] | undefined>): RemoteView {
  const collection = one(sp.collection);
  return {
    collection: collection && collection.length <= 64 ? collection : null,
    q: (one(sp.q) ?? '').trim().slice(0, REMOTE_Q_MAX),
    cursor: one(sp.cursor)?.slice(0, 200) ?? null,
    view: sp.view === 'table' ? 'table' : 'grid',
  };
}

/** /remote/<id> with only what is set; grid is the default and not named. */
export function remoteHref(libraryId: string, v: Partial<RemoteView>): string {
  const p = new URLSearchParams();
  if (v.collection) p.set('collection', v.collection);
  if (v.q) p.set('q', v.q);
  if (v.view === 'table') p.set('view', 'table');
  if (v.cursor) p.set('cursor', v.cursor);
  const qs = p.toString();
  return `/remote/${enc(libraryId)}${qs ? `?${qs}` : ''}`;
}

export const remoteTitleHref = (libraryId: string, titleId: string) => `/remote/${enc(libraryId)}/titles/${enc(titleId)}`;

/** A disk's files page; the title rides along so the trail can lead back to it (the files route needs no title). */
export const remoteDiskHref = (libraryId: string, diskId: string, titleId: string) =>
  `/remote/${enc(libraryId)}/disks/${enc(diskId)}?title=${enc(titleId)}`;

/**
 * An owner's title as the library's leaf pieces (Cover, titleByline, kindTag) expect it. The cover goes through this
 * server (`/api/remote/<id>/covers/<title>`), keyed by its digest so a new cover is a new address.
 */
export function remoteListItem(t: ShareTitle, libraryId: string): GameListItem {
  const cover = t.hasCover
    ? `/api/remote/${enc(libraryId)}/covers/${enc(t.id)}${t.coverDigest ? `?v=${enc(t.coverDigest)}` : ''}`
    : null;
  return {
    id: t.id, title: t.title, year: t.year, publisher: t.publisher, diskCount: t.diskCount, coverAssetId: null,
    authored: false, diskId: null, holderName: null, coverUrl: cover, kind: t.kind, sizeBytes: 0, sha256Prefix: null,
    hasHd: false, hasHfe: false,
  };
}

/**
 * The host a pasted or arrived link points at, for the Add page's question ("Add the library shared from <host>?"), or
 * null when it is not a share link. Display only: http: is allowed here (a LAN self-host's link); the server's own
 * parse, with its real settings, decides what is contacted.
 */
export function shareLinkHost(raw: string): string | null {
  const p = parseShareLink(raw, { WEBADF_SHARE_TEST_INSECURE: '1' });
  if (!p) return null;
  try { return new URL(p.origin).host; } catch { return null; }
}

/** The Add page's question for a link that arrived in the address (it is never claimed without the person's click). */
export const addConfirmText = (host: string) => `Add the library shared from ${host}?`;
