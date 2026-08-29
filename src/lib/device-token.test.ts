import { describe, it, expect } from 'vitest';
import { mintDeviceToken, hashDeviceToken, tokensMatch } from './device-token';

describe('device tokens', () => {
  it('mints a prefixed, high-entropy plaintext', () => {
    const { plaintext } = mintDeviceToken();
    expect(plaintext.startsWith('wadf_')).toBe(true);
    expect(plaintext.length).toBeGreaterThanOrEqual(40);
  });

  it('never mints the same token twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintDeviceToken().plaintext));
    expect(seen.size).toBe(200);
  });

  it('returns a hash that matches hashing the plaintext separately', () => {
    const { plaintext, hash } = mintDeviceToken();
    expect(hashDeviceToken(plaintext)).toBe(hash);
  });

  it('produces a 64-char lowercase hex hash', () => {
    expect(hashDeviceToken('wadf_whatever')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not store the plaintext inside the hash', () => {
    const { plaintext, hash } = mintDeviceToken();
    expect(hash).not.toContain(plaintext.slice(5));
  });

  it('compares equal hashes as equal and unequal as unequal', () => {
    const a = hashDeviceToken('one');
    expect(tokensMatch(a, hashDeviceToken('one'))).toBe(true);
    expect(tokensMatch(a, hashDeviceToken('two'))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on unequal lengths; a malformed header must not 500.
    expect(tokensMatch(hashDeviceToken('one'), 'short')).toBe(false);
  });
});
