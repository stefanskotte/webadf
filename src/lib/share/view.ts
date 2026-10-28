// What Settings > Sharing shows for a share (spec §3.4). CLIENT-SAFE: no node: imports, no @/db.

export type ShareViewStatus = 'waiting' | 'expired' | 'claimed' | 'revoked';

/** A ShareRow (src/lib/share/store.ts) as JSON: dates are ISO strings. */
export type ShareView = {
  id: string;
  label: string;
  everything: boolean;
  collectionIds: string[];
  status: ShareViewStatus;
  claimExpiresAt: string;
  claimedAt: string | null;
  claimedByUrl: string | null;
  claimedByName: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type DateLike = Date | string;
const iso = (d: DateLike) => (typeof d === 'string' ? d : d.toISOString());
const isoOrNull = (d: DateLike | null) => (d === null ? null : iso(d));

export function toShareView(r: Omit<ShareView, 'claimExpiresAt' | 'claimedAt' | 'lastUsedAt' | 'createdAt'> & {
  claimExpiresAt: DateLike; claimedAt: DateLike | null; lastUsedAt: DateLike | null; createdAt: DateLike;
}): ShareView {
  return {
    id: r.id, label: r.label, everything: r.everything, collectionIds: r.collectionIds, status: r.status,
    claimExpiresAt: iso(r.claimExpiresAt), claimedAt: isoOrNull(r.claimedAt), claimedByUrl: r.claimedByUrl,
    claimedByName: r.claimedByName, lastUsedAt: isoOrNull(r.lastUsedAt), createdAt: iso(r.createdAt),
  };
}

// One fixed locale and zone: the card renders on the server and again in the browser, and the two must agree.
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "4 Nov 2026" (UTC). */
export function shareDate(isoDate: string): string {
  return DATE.format(new Date(isoDate));
}

export function shareStatusText(s: ShareView): string {
  switch (s.status) {
    case 'waiting': return `Waiting to be claimed, until ${shareDate(s.claimExpiresAt)}`;
    case 'expired': return 'Expired';
    case 'revoked': return 'Revoked';
    case 'claimed': return `Claimed by ${s.claimedByName ?? 'someone'}${s.claimedByUrl ? ` (${s.claimedByUrl})` : ''}`;
  }
}

/** "Everything", or the collection names (sorted); ids of deleted collections are skipped. */
export function shareScopeText(s: Pick<ShareView, 'everything' | 'collectionIds'>, names: ReadonlyMap<string, string>): string {
  if (s.everything) return 'Everything';
  const list = s.collectionIds.map((id) => names.get(id)).filter((n): n is string => !!n)
    .sort((a, b) => a.localeCompare(b));
  return list.length ? list.join(', ') : 'No collections';
}

export function revokeConfirmText(label: string): string {
  return `${label} loses access immediately. Disks ${label} has changed stay theirs.`;
}

/** Mirrors deleteShare's rule (store.ts): only a revoked share or an expired unclaimed one leaves the list. */
export function canDeleteShare(status: ShareViewStatus): boolean {
  return status === 'revoked' || status === 'expired';
}
