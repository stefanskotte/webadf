import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  encodeLayout, decodeLayout, layoutMinFirmware, panelId, NFC_ELEMENT_FIRMWARE, STATUS_ICON_FIRMWARE, STATUS_OPT,
  HEAD_ELEMENT_FIRMWARE, ROTATION_FIRMWARE, ROTATION_RECORD, type LayoutJson,
} from './display-layout';

const FIX = 'wifi-floppy/firmware/test/fixtures/layouts';

describe('display layout encoding', () => {
  for (const name of ['default32', 'default64', 'custom64', 'custom32_nfc', 'custom32_status_icon', 'custom32_head_rot180', 'bad_bounds', 'bad_dup', 'bad_reserved']) {
    it(`${name}.json encodes to exactly ${name}.bin, and back`, async () => {
      const json = JSON.parse(await readFile(`${FIX}/${name}.json`, 'utf8')) as LayoutJson;
      const bin = new Uint8Array(await readFile(`${FIX}/${name}.bin`));
      if (name === 'bad_reserved') return;   // carries a nonzero reserved byte JSON cannot express
      expect(Buffer.from(encodeLayout(json)).equals(Buffer.from(bin))).toBe(true);
      expect(decodeLayout(bin)).toEqual(json);
    });
  }

  it('gives the nfc element id 9, after the eight 1.7.1 ids, which never move', () => {
    const b = encodeLayout({ panel: '128x32', elements: [{ id: 'nfc', visible: true, scale: 2, x: 4, y: 6, w: 0, opt: 0 }] });
    expect(Array.from(b)).toEqual([1, 0, 1, 0, 9, 3, 4, 6, 0, 0, 0, 0]);
  });

  it('gives the head element id 10, after nfc', () => {
    const b = encodeLayout({ panel: '128x64', elements: [{ id: 'head', visible: true, scale: 1, x: 104, y: 24, w: 0, opt: 0 }] });
    expect(Array.from(b)).toEqual([1, 1, 1, 0, 10, 1, 104, 24, 0, 0, 0, 0]);
  });

  describe('rotation (firmware 1.17.0): a setting record after the elements', () => {
    const one = { id: 'wifi' as const, visible: true, scale: 1 as const, x: 0, y: 0, w: 0, opt: 0 };
    it('180 adds [0x80 0 0 0 0 2 0 0] and counts it in the header', () => {
      expect(ROTATION_RECORD).toBe(0x80);
      const b = encodeLayout({ panel: '128x32', rotation: 180, elements: [one] });
      expect(Array.from(b)).toEqual([1, 0, 2, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0x80, 0, 0, 0, 0, 2, 0, 0]);
      expect(decodeLayout(b)).toEqual({ panel: '128x32', rotation: 180, elements: [one] });
    });
    it('0 (or none) writes no record: the bytes older boards were sent', () => {
      const plain = encodeLayout({ panel: '128x32', elements: [one] });
      expect(Array.from(encodeLayout({ panel: '128x32', rotation: 0, elements: [one] }))).toEqual(Array.from(plain));
      expect(plain.length).toBe(12);
      expect(decodeLayout(plain).rotation).toBeUndefined();
    });
    it('reads the record wherever it sits, and a record of 0 as unrotated', () => {
      const b = new Uint8Array([1, 0, 2, 0, 0x80, 0, 0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0]);
      expect(decodeLayout(b)).toEqual({ panel: '128x32', rotation: 180, elements: [one] });
      b[9] = 0;
      expect(decodeLayout(b).rotation).toBeUndefined();
    });
  });

  it('carries the status element\'s icon choice in opt (byte 5 of its record)', () => {
    const b = encodeLayout({ panel: '128x32', elements: [{ id: 'status', visible: true, scale: 1, x: 14, y: 0, w: 0, opt: STATUS_OPT.icon }] });
    expect(Array.from(b)).toEqual([1, 0, 1, 0, 1, 1, 14, 0, 0, 1, 0, 0]);
    expect(STATUS_OPT).toEqual({ word: 0, icon: 1 });
  });

  describe('layoutMinFirmware: the oldest firmware that accepts a layout', () => {
    const base = async (name: string) => JSON.parse(await readFile(`${FIX}/${name}.json`, 'utf8')) as LayoutJson;
    it('nothing beyond 1.7.1 for the defaults and a plain custom layout', async () => {
      for (const n of ['default32', 'default64', 'custom64']) expect(layoutMinFirmware(await base(n))).toBeNull();
    });
    it('the nfc element, shown or hidden: 1.10.0', async () => {
      const l = await base('custom32_nfc');
      expect(layoutMinFirmware(l)).toBe(NFC_ELEMENT_FIRMWARE);
      expect(layoutMinFirmware({ ...l, elements: l.elements.map((e) => ({ ...e, visible: false })) })).toBe(NFC_ELEMENT_FIRMWARE);
    });
    it('a status element with any opt but the word, shown or hidden: 1.15.0', async () => {
      const l = await base('custom32_status_icon');
      expect(STATUS_ICON_FIRMWARE).toBe('1.15.0');
      expect(layoutMinFirmware(l)).toBe(STATUS_ICON_FIRMWARE);
      expect(layoutMinFirmware({ ...l, elements: l.elements.map((e) => ({ ...e, visible: false })) })).toBe(STATUS_ICON_FIRMWARE);
      // Older firmware refuses ANY status opt but 0, so a later option needs 1.15.0 at least.
      expect(layoutMinFirmware({ ...l, elements: l.elements.map((e) => (e.id === 'status' ? { ...e, opt: 7 } : e)) }))
        .toBe(STATUS_ICON_FIRMWARE);
    });
    it('the head element (shown or hidden) or a 180 rotation: 1.17.0, the newest', async () => {
      expect(HEAD_ELEMENT_FIRMWARE).toBe('1.17.0');
      expect(ROTATION_FIRMWARE).toBe('1.17.0');
      const l = await base('custom32_head_rot180');
      expect(layoutMinFirmware(l)).toBe('1.17.0');
      expect(layoutMinFirmware({ ...l, rotation: 0 })).toBe(HEAD_ELEMENT_FIRMWARE);
      expect(layoutMinFirmware({ ...l, elements: l.elements.map((e) => ({ ...e, visible: false })) })).toBe('1.17.0');
      const plain = await base('default32');
      expect(layoutMinFirmware({ ...plain, rotation: 180 })).toBe(ROTATION_FIRMWARE);
      expect(layoutMinFirmware({ ...plain, rotation: 0 })).toBeNull();
      // Newer than the status icon's 1.15.0.
      const icon = await base('custom32_status_icon');
      expect(layoutMinFirmware({ ...icon, rotation: 180 })).toBe('1.17.0');
    });
    it('both: the newer of the two', async () => {
      const l = await base('custom32_status_icon');
      const nfc = (await base('custom32_nfc')).elements.find((e) => e.id === 'nfc')!;
      expect(layoutMinFirmware({ ...l, elements: [...l.elements, nfc] })).toBe(STATUS_ICON_FIRMWARE);
    });
  });

  it('maps panels to their ids', () => {
    expect(panelId('128x32')).toBe(0);
    expect(panelId('128x64')).toBe(1);
  });

  it('refuses to decode a blob whose length does not match its count', () => {
    expect(() => decodeLayout(new Uint8Array([1, 0, 1, 0]))).toThrow();
  });
});
