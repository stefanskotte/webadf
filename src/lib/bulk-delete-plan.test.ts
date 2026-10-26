import { describe, it, expect } from 'vitest';
import { planBulkDelete, type PlanDevice } from './bulk-delete-plan';

// spec §3.3 step 2, Ruling 12: which selected titles a board holds (and so are kept), by the card's own DF0 rule
// (holdsByGame), DF1's pick or content, and an open write session.
const NOW = Date.UTC(2026, 9, 26, 12);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const game = (id: string, year: number | null = 1990) => ({ id, title: `T ${id}`, year });
const disk = (gameId: string, n: number, sha256: string) => ({ id: `${gameId}-d${n}`, gameId, diskNo: n, sha256 });
const board = (o: Partial<PlanDevice> = {}): PlanDevice => ({
  id: 'b1', name: 'A500', desiredSha256: null, mountedSha256: null, lastSeenAt: new Date(NOW),
  desiredDiskId: null, mountedDiskId: null, df1DiskId: null, df1Sha256: null, ...o,
});
// g2 is a two-disk title.
const GAMES = [game('g1'), game('g2'), game('g3')];
const DISKS = [disk('g1', 1, A), disk('g2', 1, B), disk('g2', 2, C), disk('g3', 1, D)];

describe('planBulkDelete', () => {
  it('nothing held: every title is deletable, in request order, with its disks and its distinct shas', () => {
    const p = planBulkDelete(GAMES, [...DISKS, disk('g3', 2, D)], [], [], NOW);
    expect(p.deletable.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
    expect(p.deletableDiskIds).toEqual(['g1-d1', 'g2-d1', 'g2-d2', 'g3-d1', 'g3-d2']);
    expect(p.deletableShas).toEqual([A, B, C, D]);
    expect(p.kept).toEqual([]);
  });

  it('DF0 mounted (a converged board) keeps the title and says where, in holdLabel words', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({
      desiredSha256: A, mountedSha256: A, desiredDiskId: 'g1-d1', mountedDiskId: 'g1-d1',
    })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g1', title: 'T g1', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'In A500' }] }]);
    expect(p.deletable.map((g) => g.id)).toEqual(['g2', 'g3']);
    expect(p.deletableDiskIds).not.toContain('g1-d1');
    expect(p.deletableShas).not.toContain(A);
  });

  it('DF0 fetching (asked for, board online) keeps the title', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ desiredSha256: D, desiredDiskId: 'g3-d1' })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'Fetching to A500' }] }]);
  });

  it('DF0 requested (asked for, board offline) keeps the title', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({
      desiredSha256: D, desiredDiskId: 'g3-d1', lastSeenAt: new Date(NOW - 3_600_000),
    })], [], NOW);
    expect(p.kept[0].holds).toEqual([{ deviceName: 'A500', drive: 'DF0', label: 'Requested on A500 — not confirmed' }]);
  });

  it('an eject in flight holds nothing: the title is deletable', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ mountedSha256: A, mountedDiskId: 'g1-d1' })], [], NOW);
    expect(p.kept).toEqual([]);
    expect(p.deletable.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it("DF1's pick keeps the title, and says DF1", () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ df1DiskId: 'g3-d1' })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF1', label: 'In A500' }] }]);
  });

  it("DF1's reported content keeps the title, matched by sha", () => {
    const p = planBulkDelete(GAMES, DISKS, [board({ df1Sha256: A })], [], NOW);
    expect(p.kept.map((k) => k.id)).toEqual(['g1']);
    expect(p.kept[0].holds[0].drive).toBe('DF1');
  });

  it('an open write session keeps the title: "Writing on <board>"', () => {
    const p = planBulkDelete(GAMES, DISKS, [], [{ deviceId: 'b1', deviceName: 'A500', diskId: 'g3-d1' }], NOW);
    expect(p.kept).toEqual([{ id: 'g3', title: 'T g3', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'Writing on A500' }] }]);
  });

  it('a multi-disk title held by one disk is kept whole, and the label names the disk', () => {
    const p = planBulkDelete(GAMES, DISKS, [board({
      desiredSha256: C, mountedSha256: C, desiredDiskId: 'g2-d2', mountedDiskId: 'g2-d2',
    })], [], NOW);
    expect(p.kept).toEqual([{ id: 'g2', title: 'T g2', holds: [{ deviceName: 'A500', drive: 'DF0', label: 'In A500 — disk 2' }] }]);
    expect(p.deletableDiskIds).toEqual(['g1-d1', 'g3-d1']);
    expect(p.deletableShas).toEqual([A, D]);
  });

  it('kept titles keep request order, and one title held twice lists both holds', () => {
    const p = planBulkDelete([game('g3'), game('g1')], DISKS, [
      board({ desiredSha256: A, mountedSha256: A, desiredDiskId: 'g1-d1', mountedDiskId: 'g1-d1' }),
      board({ id: 'b2', name: 'A1200', df1DiskId: 'g1-d1' }),
      board({ id: 'b3', name: 'CD32', df1DiskId: 'g3-d1' }),
    ], [], NOW);
    expect(p.kept.map((k) => k.id)).toEqual(['g3', 'g1']);
    expect(p.kept[1].holds.map((h) => `${h.deviceName} ${h.drive}`)).toEqual(['A500 DF0', 'A1200 DF1']);
  });
});
