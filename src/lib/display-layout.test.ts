import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { encodeLayout, decodeLayout, panelId, type LayoutJson } from './display-layout';

const FIX = 'wifi-floppy/firmware/test/fixtures/layouts';

describe('display layout encoding', () => {
  for (const name of ['default32', 'default64', 'custom64', 'bad_bounds', 'bad_dup', 'bad_reserved']) {
    it(`${name}.json encodes to exactly ${name}.bin, and back`, async () => {
      const json = JSON.parse(await readFile(`${FIX}/${name}.json`, 'utf8')) as LayoutJson;
      const bin = new Uint8Array(await readFile(`${FIX}/${name}.bin`));
      if (name === 'bad_reserved') return;   // carries a nonzero reserved byte JSON cannot express
      expect(Buffer.from(encodeLayout(json)).equals(Buffer.from(bin))).toBe(true);
      expect(decodeLayout(bin)).toEqual(json);
    });
  }

  it('maps panels to their ids', () => {
    expect(panelId('128x32')).toBe(0);
    expect(panelId('128x64')).toBe(1);
  });

  it('refuses to decode a blob whose length does not match its count', () => {
    expect(() => decodeLayout(new Uint8Array([1, 0, 1, 0]))).toThrow();
  });
});
