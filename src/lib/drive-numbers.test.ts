import { describe, expect, it } from 'vitest';
import { asDriveBase, mainDrive, nameDrives, secondDriveName } from './drive-numbers';
import { mountChoice, holderText, type MountTargetRow } from './mount-choice';
import { holdsByGame } from './drive-holds';

describe('drive numbers', () => {
  it('reads anything unknown as DF0 + DF1', () => {
    expect([0, 1, 2, 3].map(asDriveBase)).toEqual([0, 1, 2, 3]);
    expect(asDriveBase(4)).toBe(0);
    expect(asDriveBase('2')).toBe(0);
    expect(asDriveBase(null)).toBe(0);
  });
  it('names the main drive and the next one; none after DF3', () => {
    expect([0, 1, 2, 3].map((b) => [mainDrive(b as 0), secondDriveName(b as 0)]))
      .toEqual([['DF0', 'DF1'], ['DF1', 'DF2'], ['DF2', 'DF3'], ['DF3', null]]);
    expect(mainDrive(undefined)).toBe('DF0');
  });
  it('renames DF0/DF1 in one pass, so a renamed DF1 is not renamed again', () => {
    expect(nameDrives('Already in DF0; DF1 is read-only', 1)).toBe('Already in DF1; DF2 is read-only');
    expect(nameDrives('DF1 line: connected', 2)).toBe('DF3 line: connected');
    expect(nameDrives('DF0 and DF1', 0)).toBe('DF0 and DF1');
    expect(nameDrives('DF10 stays', 1)).toBe('DF10 stays');
  });
  it('carries the numbers onto mount choices, holder lines and holds', () => {
    const now = Date.now();
    const row = {
      id: 'b1', name: 'Ext', desiredDiskId: 'd1', mountedDiskId: 'd1', desiredSha256: 'a', mountedSha256: 'a',
      desiredVersion: 1, mountedVersion: 1, lastSeenAt: new Date(now), desiredGame: 'G', desiredDiskNo: 1,
      mountedGame: 'G', mountedDiskNo: 1, df1Sha256: null, df1PickSha256: null, secondDrive: 'off', driveBase: 2,
    } as unknown as MountTargetRow;
    const disk = { id: 'd1', sha256: 'a', imageFormat: 'adf', sizeBytes: 901120 };
    const c = mountChoice(row, disk, now);
    expect([c.mainDrive, c.secondName]).toEqual(['DF2', 'DF3']);
    expect(holderText([{ ...c, isThisDisk: false, df1: { enabled: true, reason: null, isThisDisk: true }, df1Held: true }])?.text)
      .toBe('In Ext (DF3)');
    expect(holdsByGame([row], [{ id: 'd1', gameId: 'g1', diskNo: 1, sha256: 'a' }], now).g1[0].drive).toBe('DF2');
  });
});
