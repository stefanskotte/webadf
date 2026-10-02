import { describe, it, expect } from 'vitest';
import { holdsByGame, holdLabel, holdAction, type DiskRef, type HoldDeviceRow, type Hold } from './drive-holds';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const fresh = new Date(NOW - 5_000);
const old = new Date(NOW - 10 * 60_000);

const disks: DiskRef[] = [
  { id: 'd-solo', gameId: 'g-solo', diskNo: 1, sha256: 'sha-solo' },
  { id: 'd-set-1', gameId: 'g-set', diskNo: 1, sha256: 'sha-set-1' },
  { id: 'd-set-2', gameId: 'g-set', diskNo: 2, sha256: 'sha-set-2' },
];

const row = (over: Partial<HoldDeviceRow>): HoldDeviceRow => ({
  id: 'dev-1', name: 'WifiFloppy1', lastSeenAt: fresh,
  desiredSha256: null, mountedSha256: null, desiredDiskId: null, mountedDiskId: null,
  ...over,
});

describe('holdsByGame', () => {
  it('a converged board holds what it REPORTS, as mounted', () => {
    const h = holdsByGame([row({ desiredSha256: 'a', mountedSha256: 'a', desiredDiskId: 'd-solo', mountedDiskId: 'd-solo' })], disks, NOW);
    expect(h['g-solo']).toEqual([expect.objectContaining({ diskId: 'd-solo', state: 'mounted', online: true, revertDiskId: null })]);
  });

  it('a board with a request outstanding rings the disk ASKED for, and Cancel goes back to the one it holds', () => {
    const h = holdsByGame([row({
      desiredSha256: 'b', mountedSha256: 'a', desiredDiskId: 'd-set-2', mountedDiskId: 'd-solo',
    })], disks, NOW);
    expect(h['g-set']).toEqual([expect.objectContaining({ diskNo: 2, state: 'fetching', revertDiskId: 'd-solo' })]);
    expect(h['g-solo']).toBeUndefined();
  });

  it('an offline board with a request outstanding is requested, not fetching', () => {
    const h = holdsByGame([row({ desiredSha256: 'b', desiredDiskId: 'd-solo', lastSeenAt: old })], disks, NOW);
    expect(h['g-solo']).toEqual([expect.objectContaining({ state: 'requested', online: false, revertDiskId: null })]);
  });

  it('matches on the digest when the disk id is null, as mount-choice does', () => {
    const h = holdsByGame([row({ desiredSha256: 'sha-set-1', mountedSha256: 'sha-set-1' })], disks, NOW);
    expect(h['g-set']).toEqual([expect.objectContaining({ diskId: 'd-set-1', state: 'mounted' })]);
  });

  it('an eject in flight rings nothing', () => {
    expect(holdsByGame([row({ desiredSha256: null, mountedSha256: 'a', mountedDiskId: 'd-solo' })], disks, NOW)).toEqual({});
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

describe('holdLabel and holdAction', () => {
  const h: Hold = { deviceId: 'x', deviceName: 'WifiFloppy1', diskId: 'd', diskNo: 2, state: 'mounted', online: true, revertDiskId: null };
  it('says where, which disk of a set, and offline', () => {
    expect(holdLabel(h, 1)).toBe('In WifiFloppy1');
    expect(holdLabel(h, 3)).toBe('In WifiFloppy1 — disk 2');
    expect(holdLabel({ ...h, online: false }, 1)).toBe('In WifiFloppy1 (offline)');
    expect(holdLabel({ ...h, state: 'fetching' }, 3)).toBe('Fetching to WifiFloppy1 — disk 2');
    expect(holdLabel({ ...h, state: 'requested', online: false }, 1)).toBe('Requested on WifiFloppy1 — not confirmed');
  });
  it('ejects a confirmed disk and cancels a request', () => {
    expect(holdAction(h)).toBe('Eject');
    expect(holdAction({ ...h, state: 'fetching' })).toBe('Cancel');
    expect(holdAction({ ...h, state: 'requested' })).toBe('Cancel');
  });
});
