// src/lib/send-http.test.ts
// storeSendBytes never reuses bytes it has not checked: a presigned PUT that was never committed can plant other bytes
// at any adf/<sha>, and a Send, a board's close or a STASH: write would otherwise name them (final review, increment 2).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

process.env.STORAGE_DIR = (await import('node:fs')).mkdtempSync('/tmp/webadf-send-http-');
process.env.BLOB_READ_WRITE_TOKEN = '';
const { diskStore } = await import('@/lib/storage');
const { storeSendBytes } = await import('./send-http');

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
afterEach(() => vi.restoreAllMocks());

describe('storeSendBytes', () => {
  it('replaces bytes planted at the key, of the same size or another, with the real ones', async () => {
    for (const [planted, good] of [['EVIL', 'GOOD'], ['evil bytes of another length', 'good bytes']]) {
      const real = new TextEncoder().encode(good);
      const key = sha(real);
      await diskStore.put(key, new TextEncoder().encode(planted));
      expect(await storeSendBytes(real)).toBe(key);
      expect(await diskStore.read(key)).toEqual(real);
    }
  });
  it('reuses a blob that already holds these bytes without storing them again', async () => {
    const real = new TextEncoder().encode('already here');
    await diskStore.put(sha(real), real);
    const put = vi.spyOn(diskStore, 'put');
    expect(await storeSendBytes(real)).toBe(sha(real));
    expect(put).not.toHaveBeenCalled();
    expect(await diskStore.read(sha(real))).toEqual(real);
  });
  it('stores bytes the store does not have', async () => {
    const real = new TextEncoder().encode('brand new');
    expect(await storeSendBytes(real)).toBe(sha(real));
    expect(await diskStore.read(sha(real))).toEqual(real);
  });
});
