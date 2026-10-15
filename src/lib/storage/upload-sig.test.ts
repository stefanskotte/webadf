import { beforeEach, describe, expect, it } from 'vitest';
import { signUpload, verifyUpload } from './upload-sig';

const SECRET = 'test-secret-0123456789abcdef0123456789';
const SHA = 'a'.repeat(64);
const KEY = `adf/${SHA}`;

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = SECRET;
  process.env.BETTER_AUTH_URL = 'https://example.test';
});

describe('upload signatures', () => {
  it('signs an absolute URL on the app and verifies it', async () => {
    const { url, expiresAt } = await signUpload(KEY, 1000, 60_000, 1_000_000);
    const u = new URL(url);
    expect(u.origin).toBe('https://example.test');
    expect(u.pathname).toBe(`/api/blob-upload/${KEY}`);
    expect(expiresAt.getTime()).toBe(1_060_000);
    expect(verifyUpload(KEY, u.searchParams, 1_000_000)).toEqual({ ok: true, max: 1000 });
  });

  it('rejects an expired URL', async () => {
    const { url } = await signUpload(KEY, 1000, 60_000, 1_000_000);
    expect(verifyUpload(KEY, new URL(url).searchParams, 1_061_000)).toEqual({ ok: false, status: 403 });
  });

  it('rejects tampering and missing params', async () => {
    const { url } = await signUpload(KEY, 1000, 60_000, 1_000_000);
    const q = () => new URL(url).searchParams;
    const bad = q(); bad.set('max', '999999');
    expect(verifyUpload(KEY, bad, 1_000_000).ok).toBe(false);
    expect(verifyUpload(`adf/${'b'.repeat(64)}`, q(), 1_000_000).ok).toBe(false);
    const sig = q(); sig.set('sig', 'x' + sig.get('sig')!.slice(1));
    expect(verifyUpload(KEY, sig, 1_000_000).ok).toBe(false);
    const nosig = q(); nosig.delete('sig');
    expect(verifyUpload(KEY, nosig, 1_000_000)).toEqual({ ok: false, status: 403 });
    expect(verifyUpload(KEY, new URLSearchParams(), 1_000_000)).toEqual({ ok: false, status: 403 });
  });

  it('rejects a URL signed under another secret', async () => {
    process.env.BETTER_AUTH_SECRET = 'another-secret-0123456789abcdef012345';
    const { url } = await signUpload(KEY, 1000, 60_000, 1_000_000);
    process.env.BETTER_AUTH_SECRET = SECRET;
    expect(verifyUpload(KEY, new URL(url).searchParams, 1_000_000).ok).toBe(false);
  });
});
