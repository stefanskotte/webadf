import { describe, it, expect } from 'vitest';
import { normalizeInviteCode } from './invites';

// Mirrors the private generating alphabet in ./invites. Kept in sync
// deliberately (not imported) so the property test below still fails loudly
// if the alphabet is ever edited back to include an ambiguous character --
// the whole point is that this list is asserted against, not derived from,
// the implementation.
const GENERATING_ALPHABET = '23456789ABCDEFGHJKMNPRSTUVWXYZ';

describe('normalizeInviteCode', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalizeInviteCode(' ab3-4kd ')).toBe('AB34KD');
  });

  it('maps visually ambiguous characters onto the canonical alphabet', () => {
    // The alphabet excludes O/0 and I/1/L confusion; a human retyping a code
    // from a screen must not be defeated by it.
    expect(normalizeInviteCode('o0iIlL')).toBe('001111');
  });

  it('is idempotent', () => {
    const once = normalizeInviteCode('ab3-4kd');
    expect(normalizeInviteCode(once)).toBe(once);
  });

  it('leaves an already-canonical code untouched', () => {
    expect(normalizeInviteCode('XY7K2M')).toBe('XY7K2M');
  });

  // The bug this catches: if the generating alphabet contains a character
  // that the normalizer maps to something else (e.g. it used to include `Q`,
  // which normalizeInviteCode maps to `0` -- a character absent from the
  // alphabet), any issued code containing that character normalizes to a
  // string no stored row can ever match. It fails as `unknown` with no clue
  // why, and the invite is permanently unredeemable. Every character the
  // generator can actually emit must therefore survive normalization
  // unchanged -- checked here over the whole alphabet, not spot-checked.
  it('leaves every character the generator can emit unchanged', () => {
    for (const ch of GENERATING_ALPHABET) {
      expect(normalizeInviteCode(ch)).toBe(ch);
    }
    // And, as a corollary, a full-length code drawn entirely from the
    // alphabet round-trips as a whole, not just character-by-character.
    const code = GENERATING_ALPHABET.repeat(3).slice(0, 8);
    expect(normalizeInviteCode(code)).toBe(code);
  });
});
