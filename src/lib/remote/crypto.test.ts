import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sealToken, openToken } from './crypto';

const TOKEN = 'wfst_' + 'A'.repeat(43);

describe('share token sealing', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.BETTER_AUTH_SECRET; process.env.BETTER_AUTH_SECRET = 'secret-one-for-tests'; });
  afterEach(() => { if (saved === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = saved; });

  it('round trips, and never stores the plaintext', () => {
    const sealed = sealToken(TOKEN, 'lib-1');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain('AAAA');
    expect(openToken(sealed, 'lib-1')).toBe(TOKEN);
  });

  it('two seals of one token differ (fresh iv)', () => {
    expect(sealToken(TOKEN, 'lib-1')).not.toBe(sealToken(TOKEN, 'lib-1'));
  });

  it('a tampered ciphertext throws', () => {
    const sealed = sealToken(TOKEN, 'lib-1');
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    raw[14] ^= 1;
    expect(() => openToken('v1.' + raw.toString('base64url'), 'lib-1')).toThrow();
  });

  it('a tampered tag throws', () => {
    const sealed = sealToken(TOKEN, 'lib-1');
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(() => openToken('v1.' + raw.toString('base64url'), 'lib-1')).toThrow();
  });

  it('a different secret cannot open it', () => {
    const sealed = sealToken(TOKEN, 'lib-1');
    process.env.BETTER_AUTH_SECRET = 'secret-two-for-tests';
    expect(() => openToken(sealed, 'lib-1')).toThrow();
  });

  it('a token sealed for one library does not open under another id', () => {
    const sealed = sealToken(TOKEN, 'lib-1');
    expect(() => openToken(sealed, 'lib-2')).toThrow();
    expect(openToken(sealed, 'lib-1')).toBe(TOKEN);
  });

  it('refuses unknown formats', () => {
    expect(() => openToken('v2.abc', 'lib-1')).toThrow();
    expect(() => openToken('v1.', 'lib-1')).toThrow();
  });

  it('refuses to seal without a secret', () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => sealToken(TOKEN, 'lib-1')).toThrow(/BETTER_AUTH_SECRET/);
  });
});
