// The editor's layout JSON <-> the board's layout blob (spec 2026-10-04-oled-layouts §5).
//
//   header, 4 bytes:  [0] format = 1  [1] panel (0 = 128x32, 1 = 128x64)  [2] n (0..16)  [3] 0
//   record, 8 bytes:  [0] id (1..10)  [1] flags (bit0 visible, bit1 2x)  [2] x  [3] y  [4] w  [5] opt  [6] 0  [7] 0
//   rotation record (firmware 1.17.0), after the elements, only when turned:
//                     [0] 0x80  [1..4] 0  [5] quarter turns (2 = 180 degrees)  [6] 0  [7] 0
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
export const ELEMENT_NAMES = ['status', 'wifi', 'write', 'title', 'detail', 'track', 'download', 'lemming', 'nfc', 'head'] as const;

/** The first firmware whose layout validator knows the 'nfc' element. */
export const NFC_ELEMENT_FIRMWARE = '1.10.0';

/**
 * 'head' (id 10): the head position as cylinder.side, "40.1" (FlashFloppy's
 * reading). Boards on 1.10.0-1.16.x skip an id they do not know, but would
 * show nothing for it; 1.7.1-1.9.x refuse the layout -- so it is offered and
 * sent only to boards on this version or newer.
 */
export const HEAD_ELEMENT_FIRMWARE = '1.17.0';

/**
 * The panel turned 180 degrees, for a board mounted upside down: a setting
 * record (id ROTATION_RECORD) in the same blob, so it is stored, fetched and
 * kept in flash with the layout. 1.10.0-1.16.x skip the record and draw
 * upright; 1.7.1-1.9.x refuse it -- so it is sent only to this version or newer.
 */
export const ROTATION_FIRMWARE = '1.17.0';
export const ROTATION_RECORD = 0x80;
export type Rotation = 0 | 180;
export type ElementName = (typeof ELEMENT_NAMES)[number];

/**
 * The status element's opt (display_layout.h STATUS_OPT_*): the word, or an
 * 8x8 icon in its place. Firmware before STATUS_ICON_FIRMWARE refuses a
 * status opt other than 0 -- the whole layout, shown or hidden -- so the icon
 * is only ever sent to a board that draws it. From 1.15.0 an opt the board
 * does not know draws the word.
 */
export const STATUS_OPT = { word: 0, icon: 1 } as const;
export const STATUS_ICON_FIRMWARE = '1.15.0';

/**
 * The oldest firmware that accepts `j`, beyond display layouts themselves
 * (1.7.1): null when any board with layouts does. The status icon's minimum
 * is the newer of the two, so it is checked first.
 */
export function layoutMinFirmware(j: LayoutJson): string | null {
  if (j.rotation === 180) return ROTATION_FIRMWARE;
  if (j.elements.some((e) => e.id === 'head')) return HEAD_ELEMENT_FIRMWARE;
  if (j.elements.some((e) => e.id === 'status' && e.opt !== STATUS_OPT.word)) return STATUS_ICON_FIRMWARE;
  if (j.elements.some((e) => e.id === 'nfc')) return NFC_ELEMENT_FIRMWARE;
  return null;
}

export interface ElementJson {
  id: ElementName;
  visible: boolean;
  scale: 1 | 2;
  x: number; y: number; w: number; opt: number;
}
/** `rotation` absent means 0: the shape every layout had before 1.17.0. */
export type LayoutJson = { panel: '128x32' | '128x64'; rotation?: Rotation; elements: ElementJson[] };

const FORMAT = 1;
const HEADER = 4;
const RECORD = 8;
const FLAG_VISIBLE = 1;
const FLAG_2X = 2;

export function panelId(p: LayoutJson['panel']): 0 | 1 {
  return p === '128x64' ? 1 : 0;
}

export function encodeLayout(j: LayoutJson): Uint8Array {
  const turned = j.rotation === 180;
  const records = j.elements.length + (turned ? 1 : 0);
  const out = new Uint8Array(HEADER + RECORD * records);
  out[0] = FORMAT;
  out[1] = panelId(j.panel);
  out[2] = records;
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
  if (turned) {
    const r = HEADER + RECORD * j.elements.length;
    out[r] = ROTATION_RECORD;
    out[r + 5] = 2;
  }
  return out;
}

/** For loading a stored blob into the editor. Throws on a blob it cannot read (not a validator). */
export function decodeLayout(b: Uint8Array): LayoutJson {
  if (b.length < HEADER || b[0] !== FORMAT) throw new Error('not a layout blob');
  const n = b[2];
  if (b.length !== HEADER + RECORD * n) throw new Error(`layout length ${b.length} does not match ${n} elements`);
  const elements: ElementJson[] = [];
  let rotation: Rotation | undefined;
  for (let i = 0; i < n; i++) {
    const r = HEADER + RECORD * i;
    if (b[r] === ROTATION_RECORD) {
      if (b[r + 5] === 2) rotation = 180;
      continue;
    }
    const id = ELEMENT_NAMES[b[r] - 1];
    if (!id) throw new Error(`unknown element id ${b[r]}`);
    elements.push({
      id,
      visible: (b[r + 1] & FLAG_VISIBLE) !== 0,
      scale: (b[r + 1] & FLAG_2X) !== 0 ? 2 : 1,
      x: b[r + 2], y: b[r + 3], w: b[r + 4], opt: b[r + 5],
    });
  }
  const panel = b[1] === 1 ? '128x64' : '128x32';
  return rotation ? { panel, rotation, elements } : { panel, elements };
}
