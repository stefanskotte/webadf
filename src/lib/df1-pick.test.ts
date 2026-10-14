import { describe, it, expect } from 'vitest';
import {
  DF1_PICK_FW, DF1_REFUSAL_TEXT, df1Refusal, df1Option, df1BoardOf, df1LineText, isStandardDd, type Df1Board,
} from './df1-pick';

const ON: Df1Board = {
  secondDrive: 'df1', secondDriveReported: 'df1', secondDriveVersion: 3, secondDriveAppliedVersion: 3,
  firmwareVersion: '1.12.0+gabc1234', desiredDiskId: 'disk-df0', mountedDiskId: 'disk-df0', df1DiskId: null,
};
const DD = { id: 'disk-x', imageFormat: 'adf', sizeBytes: 901_120 };

describe('who may mount what into DF1 (spec §3.1)', () => {
  it('names the firmware that holds a pick', () => expect(DF1_PICK_FW).toBe('1.12.0'));

  it('a standard DD disk on a board running On with 1.12.0 is allowed', () => {
    expect(df1Refusal(ON, DD)).toBeNull();
    expect(df1Refusal({ ...ON, firmwareVersion: '1.13.2+g1' }, DD)).toBeNull();
  });

  it('each refusal, first the setting, then the board, then the disk', () => {
    expect(df1Refusal({ ...ON, secondDrive: 'off' }, DD)).toBe('df1_off');
    expect(df1Refusal({ ...ON, secondDrive: 'net' }, DD)).toBe('df1_off');
    expect(df1Refusal({ ...ON, secondDriveAppliedVersion: 2 }, DD)).toBe('waiting');
    expect(df1Refusal({ ...ON, secondDriveReported: 'off' }, DD)).toBe('waiting');
    expect(df1Refusal({ ...ON, secondDriveAppliedVersion: null }, DD)).toBe('waiting');
    expect(df1Refusal({ ...ON, firmwareVersion: '1.11.1+g0a157eb' }, DD)).toBe('firmware_too_old');
    expect(df1Refusal({ ...ON, firmwareVersion: null }, DD)).toBe('firmware_too_old');
    expect(df1Refusal(ON, { ...DD, imageFormat: 'hfe' })).toBe('not_dd');
    expect(df1Refusal(ON, { ...DD, sizeBytes: 1_802_240 })).toBe('not_dd');
    expect(df1Refusal(ON, { ...DD, sizeBytes: 901_119 })).toBe('not_dd');
    expect(df1Refusal(ON, { ...DD, id: 'disk-df0' })).toBe('in_df0');
  });

  it('says each refusal in the spec words', () => {
    expect(DF1_REFUSAL_TEXT).toEqual({
      df1_off: 'DF1 is off',
      waiting: 'Waiting for the board',
      firmware_too_old: 'Needs firmware 1.12.0',
      not_dd: 'DF1 takes standard DD disks only',
      in_df0: 'Already in DF0',
    });
  });

  it('"in DF0" is the disk DF0 is about to hold, else the one it holds', () => {
    // DF0 is moving away from x to another disk: x may go to DF1.
    expect(df1Refusal({ ...ON, desiredDiskId: 'disk-new', mountedDiskId: 'disk-x' }, DD)).toBeNull();
    // Nothing asked for: the disk DF0 holds counts.
    expect(df1Refusal({ ...ON, desiredDiskId: null, mountedDiskId: 'disk-x' }, DD)).toBe('in_df0');
  });

  it('compares disk ROWS, not digests: the same image under another row may go to DF1 (Review Focus 2)', () => {
    expect(df1Refusal(ON, { ...DD, id: 'disk-df0-copy' })).toBeNull();
  });

  it('a standard DD disk is an ADF of exactly 901,120 bytes', () => {
    expect(isStandardDd({ imageFormat: 'adf', sizeBytes: 901_120 })).toBe(true);
    expect(isStandardDd({ imageFormat: 'adf', sizeBytes: 1_802_240 })).toBe(false);
    expect(isStandardDd({ imageFormat: 'hfe', sizeBytes: 901_120 })).toBe(false);
  });
});

describe('df1Option: what a Mount button offers', () => {
  it('no DF1 control unless the setting is On (D1: Off and Network mount to DF0 as today)', () => {
    expect(df1Option({ ...ON, secondDrive: 'off' }, DD)).toBeNull();
    expect(df1Option({ ...ON, secondDrive: 'net' }, DD)).toBeNull();
  });
  it('enabled, with no reason, when allowed', () => {
    expect(df1Option(ON, DD)).toEqual({ enabled: true, reason: null, isThisDisk: false });
  });
  it('disabled with the reason in words', () => {
    expect(df1Option({ ...ON, firmwareVersion: '1.11.1+g0a157eb' }, DD))
      .toEqual({ enabled: false, reason: 'Needs firmware 1.12.0', isThisDisk: false });
    expect(df1Option(ON, { ...DD, imageFormat: 'hfe' }))
      .toEqual({ enabled: false, reason: 'DF1 takes standard DD disks only', isThisDisk: false });
  });
  it('the disk already in DF1 is offered for ejecting, whatever else holds', () => {
    expect(df1Option({ ...ON, df1DiskId: 'disk-x', firmwareVersion: null }, DD))
      .toEqual({ enabled: true, reason: null, isThisDisk: true });
  });
  it('df1BoardOf copies exactly the eight fields', () => {
    const extra = { ...ON, displayLayout: 'AAAA', name: 'Bench' } as Df1Board & { displayLayout: string; name: string };
    expect(Object.keys(df1BoardOf(extra)).sort()).toEqual(Object.keys(ON).sort());
  });
});

describe('df1LineText: the card DF1 line, both states in words', () => {
  const none = { df1DiskId: null, df1PickTitle: null, df1PickDiskNo: null, df1PickSha256: null, df1Sha256: null };
  const P = 'e'.repeat(64);
  it('without a pick: the next disk of the set, empty or not', () => {
    expect(df1LineText(none, null)).toBe('DF1: next disk of the set — empty');
    expect(df1LineText({ ...none, df1Sha256: 'b'.repeat(64) },
      { diskNo: 2, diskCount: 3, wraps: false, preload: 'ready' })).toBe('DF1: next disk of the set — disk 2');
    expect(df1LineText({ ...none, df1Sha256: 'b'.repeat(64) }, null)).toBe('DF1: next disk of the set — ready');
  });
  it('with a pick: its title and disk number, read-only, and loading until the board reports it', () => {
    const pick = { df1DiskId: 'disk-x', df1PickTitle: 'Lotus', df1PickDiskNo: 2, df1PickSha256: P, df1Sha256: null };
    expect(df1LineText(pick, null)).toBe('DF1: Lotus disk 2 — read-only, loading');
    expect(df1LineText({ ...pick, df1Sha256: 'b'.repeat(64) }, null)).toBe('DF1: Lotus disk 2 — read-only, loading');
    expect(df1LineText({ ...pick, df1Sha256: P }, null)).toBe('DF1: Lotus disk 2 — read-only');
    expect(df1LineText({ ...pick, df1Sha256: P, df1PickTitle: null }, null)).toBe('DF1: A disk disk 2 — read-only');
  });
});
