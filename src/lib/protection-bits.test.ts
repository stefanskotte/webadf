import { describe, it, expect } from 'vitest';
import { protectionString } from '@/lib/adffs/dir';
import { bitsFromProtection, PROTECTION_FLAGS } from './protection-bits';

describe('bitsFromProtection', () => {
  it('turns every shown string back into the low eight bits it came from', () => {
    for (let bits = 0; bits < 256; bits++) {
      expect(bitsFromProtection(protectionString(bits))).toBe(bits);
    }
  });

  it('names the eight flags in the order the string shows them', () => {
    expect(PROTECTION_FLAGS.map((f) => f.letter).join('')).toBe('hsparwed');
  });
});
