import { describe, it, expect } from 'vitest';
import { BlobExistsError, type BlobBackend } from './backend';

const bytes = (s: string) => new TextEncoder().encode(s);
async function text(b: BlobBackend, k: string) {
  const o = await b.get(k);
  return o ? new TextDecoder().decode(new Uint8Array(await new Response(o.stream).arrayBuffer())) : null;
}

/**
 * One suite every BlobBackend must pass. Run against the local-disk backend
 * and the in-memory fake; never against the real Vercel Blob service (tests
 * must not touch production storage).
 */
export function backendContract(name: string, make: () => Promise<BlobBackend>) {
  describe(`${name}: BlobBackend contract`, () => {
    it('puts, reads, heads and deletes', async () => {
      const b = await make();
      await b.put('adf/aa', bytes('hello'), { contentType: 'application/octet-stream', overwrite: false });
      expect(await text(b, 'adf/aa')).toBe('hello');
      expect((await b.head('adf/aa'))?.sizeBytes).toBe(5);
      expect((await b.get('adf/aa'))?.sizeBytes).toBe(5);
      await b.del('adf/aa');
      expect(await b.get('adf/aa')).toBeNull();
      expect(await b.head('adf/aa')).toBeNull();
      await b.del('adf/aa'); // idempotent
    });
    it('reads a byte range, clamped at the end; null when absent', async () => {
      const b = await make();
      await b.put('adf/rr', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { contentType: 'application/octet-stream', overwrite: false });
      expect([...(await b.getRange('adf/rr', 3, 6))!]).toEqual([3, 4, 5, 6]);
      expect([...(await b.getRange('adf/rr', 8, 20))!]).toEqual([8, 9]);
      expect(await b.getRange('adf/none', 0, 1)).toBeNull();
    });
    it('refuses a second put without overwrite, and keeps the first bytes', async () => {
      const b = await make();
      await b.put('adf/bb', bytes('one'), { contentType: 'x/y', overwrite: false });
      await expect(b.put('adf/bb', bytes('two'), { contentType: 'x/y', overwrite: false })).rejects.toBeInstanceOf(BlobExistsError);
      expect(await text(b, 'adf/bb')).toBe('one');
    });
    it('overwrites when asked, and keeps the content type', async () => {
      const b = await make();
      await b.put('cover/cc', bytes('one'), { contentType: 'image/png', overwrite: true });
      await b.put('cover/cc', bytes('two'), { contentType: 'image/jpeg', overwrite: true });
      const o = await b.get('cover/cc');
      expect(o?.contentType).toBe('image/jpeg');
      expect(await text(b, 'cover/cc')).toBe('two');
    });
    it('accepts a stream body', async () => {
      const b = await make();
      await b.put('demozoo/x.json', new Response('streamed').body!, { contentType: 'application/json', overwrite: true });
      expect(await text(b, 'demozoo/x.json')).toBe('streamed');
    });
    it('two concurrent puts of one key: exactly one wins', async () => {
      const b = await make();
      const r = await Promise.allSettled([
        b.put('adf/dd', bytes('A'), { contentType: 'x/y', overwrite: false }),
        b.put('adf/dd', bytes('B'), { contentType: 'x/y', overwrite: false }),
      ]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(['A', 'B']).toContain(await text(b, 'adf/dd'));
    });
    it('lists by prefix only', async () => {
      const b = await make();
      await b.put('adf/e1', bytes('1'), { contentType: 'x/y', overwrite: true });
      await b.put('adf/e2', bytes('2'), { contentType: 'x/y', overwrite: true });
      await b.put('cover/e3', bytes('3'), { contentType: 'x/y', overwrite: true });
      const keys: string[] = [];
      for await (const o of b.list('adf/')) keys.push(o.key);
      expect(keys.sort()).toEqual(expect.arrayContaining(['adf/e1', 'adf/e2']));
      expect(keys).not.toContain('cover/e3');
    });
    // Every production firmware key carries the build identity after a '+'
    // (firmware/1.13.0+g290990b.bin), so '+' must be a legal key character.
    it("round-trips a firmware key with a '+' in it", async () => {
      const b = await make();
      await b.put('firmware/1.13.0+g290990b.bin', bytes('fw'), { contentType: 'application/octet-stream', overwrite: true });
      expect(await text(b, 'firmware/1.13.0+g290990b.bin')).toBe('fw');
      expect((await b.head('firmware/1.13.0+g290990b.bin'))?.sizeBytes).toBe(2);
      await b.del('firmware/1.13.0+g290990b.bin');
      expect(await b.head('firmware/1.13.0+g290990b.bin')).toBeNull();
    });
    it('refuses keys that could escape the store', async () => {
      const b = await make();
      for (const bad of ['../x', 'adf/../../etc/passwd', '/abs', 'adf//x', 'ADF/x', 'adf/x.meta.json', 'adf/.tmp-x', '']) {
        await expect(b.put(bad, bytes('x'), { contentType: 'x/y', overwrite: true })).rejects.toThrow();
      }
    });
  });
}
