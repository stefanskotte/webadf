import { describe, it, expect } from 'vitest';
import { isHfeFilename, isServable } from './disk-format';

describe('disk-format', () => {
  it('recognises .hfe case-insensitively and nothing else', () => {
    expect(isHfeFilename('Game (1990)(X)[cr].HFE')).toBe(true);
    expect(isHfeFilename('game.hfe')).toBe(true);
    expect(isHfeFilename('game.hfe.adf')).toBe(false);
    expect(isHfeFilename('hfe')).toBe(false);
  });

  it('an ADF is servable only at exactly 901,120 bytes; an HFE always (validated at ingest); anything else never', () => {
    expect(isServable({ imageFormat: 'adf', sizeBytes: 901_120 })).toBe(true);
    expect(isServable({ imageFormat: 'adf', sizeBytes: 2_049_024 })).toBe(false);
    expect(isServable({ imageFormat: 'hfe', sizeBytes: 2_049_024 })).toBe(true);
    expect(isServable({ imageFormat: 'ipf', sizeBytes: 901_120 })).toBe(false);
  });
});
