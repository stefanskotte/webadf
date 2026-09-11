import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from './zip';

/** Fixture built by the system `zip`, so the expected bytes come from an
 *  implementation that is not ours -- the same rule the LHA tests follow. */
const buf = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 't.zip')));
const README = 'The quick brown fox jumps over the lazy dog. '.repeat(3).trimEnd() + '\n';
const dec = (b?: Uint8Array) => (b ? new TextDecoder('latin1').decode(b) : undefined);

describe('readZip', () => {
  it('inflates a deflated member to the exact original bytes', async () => {
    const { entries } = await readZip(buf);
    const readme = entries.find((e) => e.path.endsWith('readme.txt'));
    expect(readme?.method).toBe('deflate');
    expect(dec(readme?.bytes)).toBe(README);
  });

  it('reads a stored member', async () => {
    const { entries } = await readZip(buf);
    // 600 random bytes do not deflate, so zip stores them.
    const noise = entries.find((e) => e.path.endsWith('noise.bin'));
    expect(noise?.bytes).toHaveLength(600);
  });

  it('keeps nested paths and drops directory records', async () => {
    const { entries } = await readZip(buf);
    expect(entries.find((e) => e.path.endsWith('deep.txt'))?.path).toContain('sub/');
    expect(entries.every((e) => !e.path.endsWith('/'))).toBe(true);
  });

  it('reports no protection bits, because zip has nowhere to keep them', async () => {
    const { entries } = await readZip(buf);
    expect(entries.every((e) => e.protection === null)).toBe(true);
  });

  it('says "not a zip" rather than throwing on junk', async () => {
    const junk = new Uint8Array(400).map((_, i) => (i * 31) & 0xff);
    await expect(readZip(junk)).resolves.toEqual({
      entries: [], skipped: [{ path: '(archive)', reason: 'not a zip' }],
    });
  });

  it('does not throw on an empty buffer', async () => {
    await expect(readZip(new Uint8Array(0))).resolves.toBeTruthy();
  });
});
