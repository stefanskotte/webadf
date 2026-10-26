import { describe, it, expect } from 'vitest';
import { splitHint } from './drop-hint';

describe('splitHint (C7 spec §7: a phone keeps the first sentence)', () => {
  it("splits today's two hints after their first sentence", () => {
    expect(splitHint('ADF, ADZ, DMS, DMZ or HFE. Hashed in your browser first — only missing disks upload.')).toEqual({
      first: 'ADF, ADZ, DMS, DMZ or HFE.', rest: 'Hashed in your browser first — only missing disks upload.',
    });
    expect(splitHint('Any file up to 4 MB. It waits here until Transfer on the Amiga takes it, into the folder Transfer saves to.').first)
      .toBe('Any file up to 4 MB.');
  });
  it('a one-sentence hint has no rest', () => {
    expect(splitHint('Only this.')).toEqual({ first: 'Only this.', rest: '' });
  });
});
