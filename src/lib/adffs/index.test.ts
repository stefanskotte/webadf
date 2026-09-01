import { describe, it, expect } from 'vitest';
import { readVolume, readFile } from './index';
import { syntheticVolume } from './synthetic';
import { ADF_BYTES } from '@/lib/adfmfm';

describe('readVolume', () => {
  it('reports a whole volume with its tree', () => {
    const adf = syntheticVolume({
      volumeName: 'Workbench3.1', filesystem: 'FFS',
      entries: [{ name: 'C', entries: [{ name: 'SetPatch', bytes: new Uint8Array(64) }] }],
    });
    const r = readVolume(adf);
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.volume.name).toBe('Workbench3.1');
    expect(r.volume.filesystem).toBe('FFS');
    expect(r.root[0].name).toBe('C');
    expect(r.root[0].children[0].name).toBe('SetPatch');
  });

  it('rejects anything that is not an 880 KB image', () => {
    expect(readVolume(new Uint8Array(1024))).toEqual({ ok: false, reason: 'not-adf' });
  });

  it('reports a missing DOS signature distinctly from a missing filesystem', () => {
    // The page shows these differently, and one archive disk is each shape.
    expect(readVolume(syntheticVolume({ noSignature: true })))
      .toEqual({ ok: false, reason: 'no-dos-signature' });
    expect(readVolume(syntheticVolume({ breakRootChecksum: true })))
      .toEqual({ ok: false, reason: 'no-filesystem' });
  });

  it('never throws on random bytes', () => {
    const adf = new Uint8Array(ADF_BYTES);
    for (let i = 0; i < adf.length; i++) adf[i] = (i * 31 + 7) & 0xff;
    expect(() => readVolume(adf)).not.toThrow();
  });
});

describe('readFile', () => {
  it('returns a file\'s bytes by block number', () => {
    const want = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: want }] });
    const r = readVolume(adf);
    if (!r.ok) throw new Error('expected ok');
    expect(readFile(adf, r.root[0].block)!.bytes).toEqual(want);
  });

  it('returns null for a block that is not a file', () => {
    const adf = syntheticVolume({ entries: [{ name: 'A', bytes: new Uint8Array(4) }] });
    expect(readFile(adf, 0)).toBeNull();
  });
});
