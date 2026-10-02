import { describe, it, expect } from 'vitest';
import { holdsByGame, holdLabel, type DiskRef, type HoldDeviceRow } from './drive-holds';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const fresh = new Date(NOW - 5_000);
const old = new Date(NOW - 10 * 60_000);

const disks = new Map<string, DiskRef>([
  ['d-solo', { id: 'd-solo', gameId: 'g-solo', diskNo: 1 }],
  ['d-set-1', { id: 'd-set-1', gameId: 'g-set', diskNo: 1 }],
  ['d-set-2', { id: 'd-set-2', gameId: 'g-set', diskNo: 2 }],
]);

const row = (over: Partial<HoldDeviceRow>): HoldDeviceRow => ({
  id: 'dev-1', name: 'WifiFloppy1', lastSeenAt: fresh,
  desiredSha256: null, mountedSha256: null, desiredDiskId: null, mountedDiskId: null,
  ...over,
});

describe('holdsByGame', () => {
  it('a converged board holds what it REPORTS, as mounted', () => {
    const h = holdsByGame([row({ desiredSha256: 'a', mountedSha256: 'a', desiredDiskId: 'd-solo', mountedDiskId: 'd-solo' })], disks, NOW);
    expect(h['g-solo']).toEqual([expect.objectContaining({ diskId: 'd-solo', state: 'mounted', online: true })]);
  });

  it('a board with a request outstanding rings the disk ASKED for, as fetching, not the old one', () => {
    const h = holdsByGame([row({
      desiredSha256: 'b', mountedSha256: 'a', desiredDiskId: 'd-set-2', mountedDiskId: 'd-solo',
    })], disks, NOW);
    expect(h['g-set']).toEqual([expect.objectContaining({ diskNo: 2, state: 'fetching' })]);
    expect(h['g-solo']).toBeUndefined();
  });

  it('an eject in flight rings nothing', () => {
    const h = holdsByGame([row({ desiredSha256: null, mountedSha256: 'a', mountedDiskId: 'd-solo' })], disks, NOW);
    expect(h).toEqual({});
  });

  it('an empty drive, or a disk not on this page, rings nothing', () => {
    expect(holdsByGame([row({})], disks, NOW)).toEqual({});
    expect(holdsByGame([row({ desiredSha256: 'z', mountedSha256: 'z', desiredDiskId: 'elsewhere', mountedDiskId: 'elsewhere' })], disks, NOW)).toEqual({});
  });

  it('two boards holding disks of one set are both listed', () => {
    const h = holdsByGame([
      row({ desiredSha256: 'a', mountedSha256: 'a', desiredDiskId: 'd-set-1', mountedDiskId: 'd-set-1' }),
      row({ id: 'dev-2', name: 'Bench', desiredSha256: 'b', mountedSha256: 'b', desiredDiskId: 'd-set-2', mountedDiskId: 'd-set-2', lastSeenAt: old }),
    ], disks, NOW);
    expect(h['g-set'].map((x) => [x.deviceName, x.diskNo, x.online])).toEqual([['WifiFloppy1', 1, true], ['Bench', 2, false]]);
  });
});

describe('holdLabel', () => {
  it('says where, which disk of a set, and offline', () => {
    const h = { deviceId: 'x', deviceName: 'WifiFloppy1', diskId: 'd', diskNo: 2, state: 'mounted' as const, online: true };
    expect(holdLabel(h, 1)).toBe('In WifiFloppy1');
    expect(holdLabel(h, 3)).toBe('In WifiFloppy1 — disk 2');
    expect(holdLabel({ ...h, state: 'fetching', online: false }, 3)).toBe('Fetching to WifiFloppy1 — disk 2 (offline)');
  });
});
