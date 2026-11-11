import { describe, expect, it } from 'vitest';
import { asFittedAs, mainDrive } from './fitted-as';
import { mountChoice, type MountTargetRow } from './mount-choice';
import { holdsByGame } from './drive-holds';

describe('fitted as', () => {
  it('reads anything unknown as inside the Amiga', () => {
    expect(asFittedAs('external')).toBe('external');
    expect(asFittedAs('internal')).toBe('internal');
    expect(asFittedAs(null)).toBe('internal');
    expect(asFittedAs('sideways')).toBe('internal');
  });
  it('names the main drive DF1 only in an external case', () => {
    expect(mainDrive('internal')).toBe('DF0');
    expect(mainDrive(undefined)).toBe('DF0');
    expect(mainDrive('external')).toBe('DF1');
  });
  it('carries the name onto mount choices and holds', () => {
    const now = Date.now();
    const row = {
      id: 'b1', name: 'Ext', desiredDiskId: 'd1', mountedDiskId: 'd1', desiredSha256: 'a', mountedSha256: 'a',
      desiredVersion: 1, mountedVersion: 1, lastSeenAt: new Date(now), desiredGame: 'G', desiredDiskNo: 1,
      mountedGame: 'G', mountedDiskNo: 1, df1Sha256: null, df1PickSha256: null, secondDrive: 'off',
      fittedAs: 'external',
    } as unknown as MountTargetRow;
    const disk = { id: 'd1', sha256: 'a', imageFormat: 'adf', sizeBytes: 901120 };
    expect(mountChoice(row, disk, now).mainDrive).toBe('DF1');
    expect(mountChoice({ ...row, fittedAs: undefined }, disk, now).mainDrive).toBe('DF0');
    const holds = holdsByGame([row], [{ id: 'd1', gameId: 'g1', diskNo: 1, sha256: 'a' }], now);
    expect(holds.g1[0].drive).toBe('DF1');
  });
});
