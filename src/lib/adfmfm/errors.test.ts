import { describe, it, expect } from 'vitest';
import { AdfmfmError } from './errors';
import { AdfFormatError } from './adf';
import { TrackDecodeError, encodeTrack } from './track';
import { WfmfFormatError, readWfmf } from './wfmf';
import { MfmFormatError, checksum } from './mfm';

describe('AdfmfmError', () => {
  it('is the common base of every domain error this module throws', () => {
    expect(new AdfFormatError('x')).toBeInstanceOf(AdfmfmError);
    expect(new TrackDecodeError('x')).toBeInstanceOf(AdfmfmError);
    expect(new WfmfFormatError('x')).toBeInstanceOf(AdfmfmError);
    expect(new MfmFormatError('x')).toBeInstanceOf(AdfmfmError);
  });

  it('lets a caller catch every domain error with a single AdfmfmError handler', () => {
    const thrown: unknown[] = [];
    const attempts: Array<() => void> = [
      () => encodeTrack(new Uint8Array(1), 0), // AdfFormatError: wrong length
      () => encodeTrack(new Uint8Array(5632), -1), // AdfFormatError: bad track number
      () => checksum(new Uint8Array(3)), // MfmFormatError: not a multiple of 4
      () => readWfmf(new Uint8Array(4)), // WfmfFormatError: shorter than a header
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (e) {
        expect(e).toBeInstanceOf(AdfmfmError);
        thrown.push(e);
      }
    }
    expect(thrown).toHaveLength(attempts.length);
  });
});
