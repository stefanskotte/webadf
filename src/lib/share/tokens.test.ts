import { describe, it, expect } from 'vitest';
import { SHARE_PROTOCOL, mintClaimCode, mintShareToken, hashSecret } from './tokens';

describe('share tokens', () => {
  it('protocol is 1', () => expect(SHARE_PROTOCOL).toBe(1));
  it('claim code: wfsc_ prefix, 32 bytes of entropy, hash of the plaintext', () => {
    const c = mintClaimCode();
    expect(c.plaintext.startsWith('wfsc_')).toBe(true);
    expect(Buffer.from(c.plaintext.slice(5), 'base64url')).toHaveLength(32);
    expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.hash).toBe(hashSecret(c.plaintext));
  });
  it('share token: wfst_ prefix, 32 bytes of entropy, hash of the plaintext', () => {
    const t = mintShareToken();
    expect(t.plaintext.startsWith('wfst_')).toBe(true);
    expect(Buffer.from(t.plaintext.slice(5), 'base64url')).toHaveLength(32);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).toBe(hashSecret(t.plaintext));
  });
  it('is distinct per call', () => {
    expect(mintClaimCode().plaintext).not.toBe(mintClaimCode().plaintext);
    expect(mintShareToken().hash).not.toBe(mintShareToken().hash);
  });
});
