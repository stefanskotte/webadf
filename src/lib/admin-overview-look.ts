// The admin Overview's look rules (C6 spec §2): pure and client-safe. Plain numbers in, so this file never imports
// the quarantined admin-queries module.
import type { AttentionKind } from '@/lib/admin-board-health';

export type NotePart = string | { id: string; value: number };
export type OverviewTile = { label: string; id: string; value: number; href: string; warn: boolean; note: NotePart[] };

type Counts = {
  users: number; orgs: number; games: number; disks: number; blobs: number; liveInvites: number;
  blobsUnchecked: number; newestUserAt: string | null;
};

/** The six tiles (Ruling 13): disks and paired boards ride in the notes, each still a digits-only element with its id. */
export function overviewTiles(c: Counts, b: { paired: number; online: number }): OverviewTile[] {
  return [
    { label: 'Users', id: 'count-users', value: c.users, href: '/admin/users', warn: false,
      note: [c.newestUserAt ? `newest ${c.newestUserAt}` : 'none yet'] },
    { label: 'Organizations', id: 'count-orgs', value: c.orgs, href: '/admin/users', warn: false,
      note: ['every library on this server'] },
    { label: 'Titles', id: 'count-games', value: c.games, href: '/admin/scan', warn: false,
      note: [{ id: 'count-disks', value: c.disks }, c.disks === 1 ? ' disk' : ' disks'] },
    { label: 'Blobs', id: 'count-blobs', value: c.blobs, href: '/admin/scan', warn: c.blobsUnchecked > 0,
      note: [c.blobsUnchecked > 0 ? `${c.blobsUnchecked} not yet scanned` : 'all scanned'] },
    { label: 'Boards online', id: 'count-boardsOnline', value: b.online, href: '/admin/firmware', warn: false,
      note: ['of ', { id: 'count-boardsPaired', value: b.paired }, ' paired'] },
    { label: 'Live invites', id: 'count-liveInvites', value: c.liveInvites, href: '/admin/invites',
      warn: c.liveInvites === 0, note: [c.liveInvites === 0 ? 'nobody can sign up' : 'each code works once'] },
  ];
}

export type ServerAttention = {
  id: 'attention-invites' | 'attention-scan'; href: string; title: string; text: string; bg: string; dot: string;
};

/** The two server-level items above the board rows (Ruling 16), in this order. */
export function serverAttention(c: { liveInvites: number; blobsUnchecked: number }): ServerAttention[] {
  const out: ServerAttention[] = [];
  if (c.liveInvites === 0) {
    out.push({ id: 'attention-invites', href: '/admin/invites', title: 'No live invite codes',
      text: 'Registration is invite-only. Issue one before sharing the sign-up link.',
      bg: 'var(--warning-bg)', dot: 'var(--fetch-dot)' });
  }
  if (c.blobsUnchecked > 0) {
    const one = c.blobsUnchecked === 1;
    out.push({ id: 'attention-scan', href: '/admin/scan', title: `${c.blobsUnchecked} ${one ? 'blob' : 'blobs'} not yet scanned`,
      text: `The nightly scan picks ${one ? 'it' : 'them'} up, or run it now.`, bg: 'var(--surface-2)', dot: 'var(--dash)' });
  }
  return out;
}

/** A board row's dot, by its first reason (reasons come error, behind, offline). */
export const ATTENTION_DOT: Record<AttentionKind, string> = {
  error: 'var(--danger-fg)', behind: 'var(--fetch-dot)', offline: 'var(--dash)',
};
/** Each reason's words colour (A7's, kept). */
export const REASON_FG: Record<AttentionKind, string> = {
  error: 'var(--danger-fg)', behind: 'var(--amber-text)', offline: 'var(--muted)',
};
