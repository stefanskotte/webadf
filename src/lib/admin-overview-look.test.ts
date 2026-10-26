import { describe, it, expect } from 'vitest';
import { overviewTiles, serverAttention, ATTENTION_DOT, REASON_FG } from '@/lib/admin-overview-look';

const COUNTS = { users: 12, orgs: 9, games: 40, disks: 63, blobs: 70, liveInvites: 3, blobsUnchecked: 0, newestUserAt: '2026-10-25' };
const BOARDS = { paired: 4, online: 2 };

describe('overviewTiles (C6 spec §2.2, Ruling 13)', () => {
  it('six links in the board order, each value the digits only', () => {
    const t = overviewTiles(COUNTS, BOARDS);
    expect(t.map((x) => [x.label, x.id, x.value, x.href])).toEqual([
      ['Users', 'count-users', 12, '/admin/users'],
      ['Organizations', 'count-orgs', 9, '/admin/users'],
      ['Titles', 'count-games', 40, '/admin/scan'],
      ['Blobs', 'count-blobs', 70, '/admin/scan'],
      ['Boards online', 'count-boardsOnline', 2, '/admin/firmware'],
      ['Live invites', 'count-liveInvites', 3, '/admin/invites'],
    ]);
  });
  it('notes: newest date, the nested disks and paired figures keep their ids', () => {
    const t = overviewTiles(COUNTS, BOARDS);
    expect(t[0].note).toEqual(['newest 2026-10-25']);
    expect(t[1].note).toEqual(['every library on this server']);
    expect(t[2].note).toEqual([{ id: 'count-disks', value: 63 }, ' disks']);
    expect(t[4].note).toEqual(['of ', { id: 'count-boardsPaired', value: 4 }, ' paired']);
    expect(overviewTiles({ ...COUNTS, disks: 1 }, BOARDS)[2].note).toEqual([{ id: 'count-disks', value: 1 }, ' disk']);
    expect(overviewTiles({ ...COUNTS, newestUserAt: null }, BOARDS)[0].note).toEqual(['none yet']);
  });
  it('both values of each warning: Blobs warns while any is unscanned, Live invites at 0', () => {
    expect(overviewTiles(COUNTS, BOARDS).map((x) => x.warn)).toEqual([false, false, false, false, false, false]);
    expect(overviewTiles(COUNTS, BOARDS)[3].note).toEqual(['all scanned']);
    expect(overviewTiles(COUNTS, BOARDS)[5].note).toEqual(['each code works once']);
    const w = overviewTiles({ ...COUNTS, blobsUnchecked: 12, liveInvites: 0 }, BOARDS);
    expect(w[3]).toMatchObject({ warn: true, note: ['12 not yet scanned'] });
    expect(w[5]).toMatchObject({ warn: true, note: ['nobody can sign up'] });
  });
});

describe('serverAttention (C6 spec §2.4, Ruling 16)', () => {
  it('nothing when invites are live and every blob is scanned', () => {
    expect(serverAttention({ liveInvites: 2, blobsUnchecked: 0 })).toEqual([]);
  });
  it('no live invites first, then the unscanned blobs, with the board words', () => {
    expect(serverAttention({ liveInvites: 0, blobsUnchecked: 12 })).toEqual([
      { id: 'attention-invites', href: '/admin/invites', title: 'No live invite codes',
        text: 'Registration is invite-only. Issue one before sharing the sign-up link.',
        bg: 'var(--warning-bg)', dot: 'var(--fetch-dot)' },
      { id: 'attention-scan', href: '/admin/scan', title: '12 blobs not yet scanned',
        text: 'The nightly scan picks them up, or run it now.', bg: 'var(--surface-2)', dot: 'var(--dash)' },
    ]);
  });
  it('one blob reads in the singular', () => {
    expect(serverAttention({ liveInvites: 1, blobsUnchecked: 1 })).toEqual([expect.objectContaining({
      title: '1 blob not yet scanned', text: 'The nightly scan picks it up, or run it now.' })]);
  });
  it('dots and reason colours by kind', () => {
    expect(ATTENTION_DOT).toEqual({ error: 'var(--danger-fg)', behind: 'var(--fetch-dot)', offline: 'var(--dash)' });
    expect(REASON_FG).toEqual({ error: 'var(--danger-fg)', behind: 'var(--amber-text)', offline: 'var(--muted)' });
  });
});
