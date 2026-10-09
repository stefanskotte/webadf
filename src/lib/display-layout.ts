// The editor's layout JSON <-> the board's layout blob (spec 2026-10-04-oled-layouts §5).
//
//   header, 4 bytes:  [0] format = 1  [1] panel (0 = 128x32, 1 = 128x64)  [2] n (0..16)  [3] 0
//   record, 8 bytes:  [0] id (1..9)  [1] flags (bit0 visible, bit1 2x)  [2] x  [3] y  [4] w  [5] opt  [6] 0  [7] 0
//
// This module ENCODES and never validates: the server runs the blob through the
// board's own C validator (display-wasm.ts), so there is one rule set. The
// encoder therefore lets through what the validator must refuse (a duplicate
// id, an element past the panel edge).

/**
 * Element names; index = id - 1. Ids are fixed forever. 'nfc' (id 9) is
 * firmware 1.10.0's: older boards refuse a layout that lists it at all, so it
 * is only ever sent to a board that has it (NFC_ELEMENT_FIRMWARE).
 */
export const ELEMENT_NAMES = ['status', 'wifi', 'write', 'title', 'detail', 'track', 'download', 'lemming', 'nfc'] as const;

/** The first firmware whose layout validator knows the 'nfc' element. */
export const NFC_ELEMENT_FIRMWARE = '1.10.0';
export type ElementName = (typeof ELEMENT_NAMES)[number];

export interface ElementJson {
  id: ElementName;
  visible: boolean;
  scale: 1 | 2;
  x: number; y: number; w: number; opt: number;
}
export type LayoutJson = { panel: '128x32' | '128x64'; elements: ElementJson[] };

const FORMAT = 1;
const HEADER = 4;
const RECORD = 8;
const FLAG_VISIBLE = 1;
const FLAG_2X = 2;

export function panelId(p: LayoutJson['panel']): 0 | 1 {
  return p === '128x64' ? 1 : 0;
}

export function encodeLayout(j: LayoutJson): Uint8Array {
  const out = new Uint8Array(HEADER + RECORD * j.elements.length);
  out[0] = FORMAT;
  out[1] = panelId(j.panel);
  out[2] = j.elements.length;
  j.elements.forEach((e, i) => {
    const r = HEADER + RECORD * i;
    const idx = ELEMENT_NAMES.indexOf(e.id);
    if (idx < 0) throw new Error(`unknown element ${String(e.id)}`);
    out[r] = idx + 1;
    out[r + 1] = (e.visible ? FLAG_VISIBLE : 0) | (e.scale === 2 ? FLAG_2X : 0);
    out[r + 2] = e.x;
    out[r + 3] = e.y;
    out[r + 4] = e.w;
    out[r + 5] = e.opt;
  });
  return out;
}

/** For loading a stored blob into the editor. Throws on a blob it cannot read (not a validator). */
export function decodeLayout(b: Uint8Array): LayoutJson {
  if (b.length < HEADER || b[0] !== FORMAT) throw new Error('not a layout blob');
  const n = b[2];
  if (b.length !== HEADER + RECORD * n) throw new Error(`layout length ${b.length} does not match ${n} elements`);
  const elements: ElementJson[] = [];
  for (let i = 0; i < n; i++) {
    const r = HEADER + RECORD * i;
    const id = ELEMENT_NAMES[b[r] - 1];
    if (!id) throw new Error(`unknown element id ${b[r]}`);
    elements.push({
      id,
      visible: (b[r + 1] & FLAG_VISIBLE) !== 0,
      scale: (b[r + 1] & FLAG_2X) !== 0 ? 2 : 1,
      x: b[r + 2], y: b[r + 3], w: b[r + 4], opt: b[r + 5],
    });
  }
  return { panel: b[1] === 1 ? '128x64' : '128x32', elements };
}
