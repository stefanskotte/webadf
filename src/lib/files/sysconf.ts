// src/lib/files/sysconf.ts
// Create SysConf (spec 2026-11-04): DEVS:system-configuration from named settings. The file is struct Preferences, 232
// bytes, big-endian; Kickstart's loader ignores a shorter one, so every byte is always written. Only the fields Kickstart
// itself reads are settings. The rest stay as TEMPLATE has them: the bytes docs/superpowers/research/system-configuration/
// mksysconfig.py writes, which hold no Commodore data (it draws its own pointer). CLIENT-SAFE.
import { z } from 'zod';

export const SYSCONF_NAME = 'system-configuration';
export const SYSCONF_SIZE = 232;

/** A pointer cell: clear, or the pointer's colour 17, 18 or 19. */
export type Ink = '.' | 'R' | 'K' | 'W';
export type SysconfSettings = {
  fontHeight: 8 | 9; interlace: boolean;
  viewX: number; viewY: number; extraRows: number; extraColumns: number;
  colors: [number, number, number, number];
  pointerColors: [number, number, number];
  pointer: string[];
  hotSpot: { x: number; y: number };
  keyDelayUs: number; keySpeedUs: number; doubleClickUs: number;
  mouseTicks: 1 | 2 | 4; acceleration: boolean;
};

export const POINTER_SIZE = 16;
export const OVERSCAN_POSITION_MAX = 16;   // overscan position, each way
export const OVERSCAN_SIZE_MAX = 64;       // overscan size, each way: 640 to 704 columns is +64
export const KEY_DELAY_US = { min: 20000, max: 2000000 };
export const KEY_SPEED_US = { min: 20000, max: 1000000 };
export const DOUBLE_CLICK_US = { min: 20000, max: 10000000 };

const TEMPLATE = 'CAAABQAAAAAAAMNQAAAAAAAJJ8AAAAABAABOIAAAAAAAAMAAQADgAGAA8ABwAPgAeAD8AHwA/gB+AP8AfwD/gHwA/8BsAP4ARgDvAAYAzwADAAeAAwAHgAAAAwAAAAAAAAAAAP8ADkQAAA7sAAEKqgAAD/8GiwAAAIEALAAAAABnZW5lcmljAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQBLAAAAAAAAAAcAIABCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAA==';

const POINTER = [
  'KK..............', 'KWK.............', 'KWWK............', 'KWWWK...........',
  'KWWWWK..........', 'KWWWWWK.........', 'KWWWWWWK........', 'KWWWWWWWK.......',
  'KWWWWWKKKK......', 'KWWKWWK.........', 'KWK.KWWK........', 'KK..KWWK........',
  '.....KWWK.......', '.....KWWK.......', '......KK........', '................',
];

/** What the Workbench disks hold, with mksysconfig.py's pointer: a fresh copy each call. */
export function sysconfDefaults(): SysconfSettings {
  return {
    fontHeight: 8, interlace: false, viewX: 0, viewY: 0, extraRows: 0, extraColumns: 0,
    colors: [0xAAA, 0x000, 0xFFF, 0x68B], pointerColors: [0xE44, 0x000, 0xEEC],
    pointer: [...POINTER], hotSpot: { x: 0, y: 0 },
    keyDelayUs: 600000, keySpeedUs: 50000, doubleClickUs: 1020000, mouseTicks: 1, acceleration: false,
  };
}

const position = z.number().int().min(-OVERSCAN_POSITION_MAX).max(OVERSCAN_POSITION_MAX);
const size = z.number().int().min(-OVERSCAN_SIZE_MAX).max(OVERSCAN_SIZE_MAX);
const color = z.number().int().min(0).max(0xFFF);
const cell = z.number().int().min(0).max(POINTER_SIZE - 1);
const us = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);
export const sysconfSchema: z.ZodType<SysconfSettings> = z.object({
  fontHeight: z.union([z.literal(8), z.literal(9)]), interlace: z.boolean(),
  viewX: position, viewY: position, extraRows: size, extraColumns: size,
  colors: z.tuple([color, color, color, color]), pointerColors: z.tuple([color, color, color]),
  pointer: z.array(z.string().regex(/^[.RKW]{16}$/)).length(POINTER_SIZE),
  hotSpot: z.object({ x: cell, y: cell }),
  keyDelayUs: us(KEY_DELAY_US), keySpeedUs: us(KEY_SPEED_US), doubleClickUs: us(DOUBLE_CLICK_US),
  // Intuition divides by this one, so 0 must never reach a file.
  mouseTicks: z.union([z.literal(1), z.literal(2), z.literal(4)]), acceleration: z.boolean(),
});

const PLANES: Record<Ink, [number, number]> = { '.': [0, 0], R: [1, 0], K: [0, 1], W: [1, 1] };

/** The 232 bytes. `s` has passed sysconfSchema: this does not check it again. */
export function buildSysconf(s: SysconfSettings): Uint8Array {
  const out = Uint8Array.from(atob(TEMPLATE), (c) => c.charCodeAt(0));
  const v = new DataView(out.buffer);
  const time = (at: number, micros: number) => {
    v.setUint32(at, Math.floor(micros / 1000000));
    v.setUint32(at + 4, micros % 1000000);
  };
  v.setInt8(0, s.fontHeight);
  time(4, s.keySpeedUs);
  time(12, s.keyDelayUs);
  time(20, s.doubleClickUs);
  // Two control words, then each row's two planes: the end words stay as the template has them.
  s.pointer.forEach((row, y) => {
    let p0 = 0, p1 = 0;
    for (const ink of row) {
      const [a, b] = PLANES[ink as Ink];
      p0 = (p0 << 1) | a;
      p1 = (p1 << 1) | b;
    }
    v.setUint16(32 + y * 4, p0);
    v.setUint16(34 + y * 4, p1);
  });
  // Intuition adds 1 to X when it reads it: Workbench's -1, 0 is pixel (0, 0).
  v.setInt8(100, -s.hotSpot.x - 1);
  v.setInt8(101, -s.hotSpot.y);
  s.pointerColors.forEach((c, i) => v.setUint16(102 + i * 2, c));
  v.setUint16(108, s.mouseTicks);
  s.colors.forEach((c, i) => v.setUint16(110 + i * 2, c));
  v.setInt8(118, s.viewX);
  v.setInt8(119, s.viewY);
  v.setUint16(124, s.acceleration ? v.getUint16(124) | 0x8000 : v.getUint16(124) & 0x7FFF);
  out[185] = s.interlace ? out[185] | 1 : out[185] & ~1;
  v.setInt8(216, s.extraRows);
  v.setInt8(217, s.extraColumns);
  return out;
}
