import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readBounded } from './bounded';
import { toAdf } from './disk-image';

const gunzipStream = (b: Uint8Array) =>
  new Blob([b as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));

describe('readBounded', () => {
  it('returns the whole output under the cap', async () => {
    const out = await readBounded(gunzipStream(gzipSync(Buffer.alloc(5000, 7))), 5000);
    expect(out?.length).toBe(5000);
  });

  it('gives up past the cap (a gzip bomb is never held whole)', async () => {
    // 64 MiB of zeros gzips to ~64 KB.
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(await readBounded(gunzipStream(bomb), 1024 * 1024)).toBeNull();
  });
});

describe('toAdf on an .adz bomb', () => {
  it('refuses rather than inflating it', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
    const r = await toAdf('bomb.adz', bomb);
    expect(r.ok).toBe(false);
  });
});
