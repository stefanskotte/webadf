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
  it('says what the board is doing with the setting', () => {
    const base = { secondDriveCapable: true, secondDriveVersion: 2, secondDriveAppliedVersion: 2 };
    expect(secondDriveStatus({ ...base, secondDriveCapable: false })).toBe('Needs firmware 1.9.0 or newer');
    expect(secondDriveStatus({ ...base, secondDriveAppliedVersion: 1 })).toBe('Waiting for the board');
    expect(secondDriveStatus(base)).toBe('Set on the board \u2014 takes effect when the Amiga restarts');
  });
});
