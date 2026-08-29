import { describe, it, expect } from 'vitest';
import { syntheticAdf } from './synthetic';

const KINDS = ['zeros', 'ones', 'prng', 'bootblock'] as const;

describe('syntheticAdf', () => {
  it.each(KINDS)('%s is exactly one ADF in length', (kind) => {
    expect(syntheticAdf(kind).length).toBe(901120);
  });

  it('zeros is all zero and ones is all 0xFF', () => {
    expect(syntheticAdf('zeros').every((b) => b === 0x00)).toBe(true);
    expect(syntheticAdf('ones').every((b) => b === 0xff)).toBe(true);
  });

  it('is deterministic across calls', () => {
    expect(syntheticAdf('prng')).toEqual(syntheticAdf('prng'));
  });

  it('prng is not degenerate: every byte value appears', () => {
    const seen = new Set(syntheticAdf('prng'));
    expect(seen.size).toBe(256);
  });

  it('bootblock opens with the AmigaDOS signature', () => {
    expect(Array.from(syntheticAdf('bootblock').slice(0, 4))).toEqual([0x44, 0x4f, 0x53, 0x00]);
  });

  it('the four disks are mutually distinct', () => {
    for (const a of KINDS) {
      for (const b of KINDS) {
        if (a === b) continue;
        expect(syntheticAdf(a), `${a} vs ${b}`).not.toEqual(syntheticAdf(b));
      }
    }
  });
});
