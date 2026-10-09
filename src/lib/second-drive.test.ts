import { describe, it, expect } from 'vitest';
import { sel1Text, df1SeenText, secondDriveStatus } from './second-drive';

describe('second-drive readings', () => {
  it('names both values of the SEL1 line', () => {
    expect(sel1Text(true)).toBe('DF1 line: connected');
    expect(sel1Text(false)).toBe('DF1 line: no signal yet');
  });
  it('names both values of the other-drive check', () => {
    expect(df1SeenText(true)).toBe('Other DF1 drive: detected');
    expect(df1SeenText(false)).toBe('Other DF1 drive: none seen');
  });
});

describe('secondDriveStatus', () => {
  const base = {
    secondDriveCapable: true, secondDriveVersion: 2, secondDriveAppliedVersion: 2,
    secondDrive: 'df1' as const, secondDriveReported: 'df1' as const, df1Sha256: null,
  };
  it('says what the board is doing with the setting', () => {
    expect(secondDriveStatus({ ...base, secondDriveCapable: false })).toBe('Needs firmware 1.9.0 or newer');
    expect(secondDriveStatus({ ...base, secondDriveAppliedVersion: 1 })).toBe('Waiting for the board');
    expect(secondDriveStatus(base)).toBe('Set on the board \u2014 takes effect when the Amiga restarts');
  });
  it('waits until the board reports running the chosen mode, not just the version (I1)', () => {
    // A re-paired board: ack 0 against the new row at Off/0, still running DF1.
    expect(secondDriveStatus({
      ...base, secondDrive: 'off', secondDriveVersion: 0, secondDriveAppliedVersion: 0, secondDriveReported: 'df1',
    })).toBe('Waiting for the board');
    expect(secondDriveStatus({ ...base, secondDriveReported: 'off' })).toBe('Waiting for the board');
    expect(secondDriveStatus({ ...base, secondDriveReported: null })).toBe('Waiting for the board');
    expect(secondDriveStatus({
      ...base, secondDrive: 'off', secondDriveVersion: 0, secondDriveAppliedVersion: 0, secondDriveReported: 'off',
    })).toBe('Set on the board \u2014 takes effect when the Amiga restarts');
  });
  it('says DF1 is on when older firmware serves a DF1 disk (I2)', () => {
    const old = { ...base, secondDriveCapable: false, secondDriveReported: null, secondDrive: 'off' as const };
    expect(secondDriveStatus({ ...old, df1Sha256: 'a'.repeat(64) }))
      .toBe('DF1 is on, set on the board \u2014 needs firmware 1.9.0 or newer to change');
    expect(secondDriveStatus({ ...old, df1Sha256: null })).toBe('Needs firmware 1.9.0 or newer');
  });
});
