import { describe, expect, it } from 'vitest';
import { syntheticVolume } from '@/lib/adffs/synthetic';
import { DC_LABEL_MAX } from '@/lib/device-limits';
import { boardDiskLabel, volumeNameOf } from './disk-label';

const base = { label: null, sourceFilename: null };

describe('boardDiskLabel: the per-disk name the board prints after its "n/c" counter', () => {
  it("the disk's own label wins (a user's, extract's, or the stored volume name)", () => {
    expect(boardDiskLabel({ ...base, label: 'Extras3.2', sourceFilename: 'wb32_extras.adf' })).toBe('Extras3.2');
  });

  it('without a label, the uploaded file name without its extension', () => {
    expect(boardDiskLabel({ ...base, sourceFilename: 'Locale.adf' })).toBe('Locale');
    expect(boardDiskLabel({ ...base, sourceFilename: 'Fonts.ADZ' })).toBe('Fonts');
  });

  it('a blank label is no label: the file name still shows', () => {
    expect(boardDiskLabel({ ...base, label: '   ', sourceFilename: 'Storage.adf' })).toBe('Storage');
    expect(boardDiskLabel({ ...base, label: '', sourceFilename: 'Storage.adf' })).toBe('Storage');
  });

  it('strips only a disk image extension ("Game v1.2" keeps its ".2")', () => {
    expect(boardDiskLabel({ ...base, sourceFilename: 'Game v1.2' })).toBe('Game v1.2');
  });

  it('with no name at all, the label is empty -- never "Disk n", on a set or a one-disk title', () => {
    // "Disk 3/13 Disk 3" was the field report; the operator then dropped "Disk"
    // from the board altogether (2026-10-17). The rule no longer looks at the
    // disk's number or count: there is no fallback left that would.
    expect(boardDiskLabel(base)).toBe('');
    expect(boardDiskLabel({ ...base, label: '  ', sourceFilename: '.adf' })).toBe('');
  });

  it("is bounded to the firmware's DC_LABEL_MAX", () => {
    const long = 'x'.repeat(DC_LABEL_MAX + 10);
    expect(boardDiskLabel({ ...base, label: long })).toHaveLength(DC_LABEL_MAX);
    expect(boardDiskLabel({ ...base, sourceFilename: `${long}.adf` })).toHaveLength(DC_LABEL_MAX);
  });
});

describe('volumeNameOf', () => {
  it("reads the AmigaDOS volume name from the root block", () => {
    expect(volumeNameOf(syntheticVolume({ volumeName: 'Install3.2' }))).toBe('Install3.2');
  });

  it('is null for a blank name, a non-DOS disk and something that is not an ADF', () => {
    expect(volumeNameOf(syntheticVolume({ volumeName: '  ' }))).toBeNull();
    expect(volumeNameOf(syntheticVolume({ noSignature: true }))).toBeNull();
    expect(volumeNameOf(new Uint8Array(1234))).toBeNull();
  });
});
