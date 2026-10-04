// Pure geometry for the Display editor (spec 2026-10-04-oled-layouts §4):
// element boxes, hit-testing, drag clamping/snapping and overlap detection.
//
// The sizes MIRROR layout_el_size() in wifi-floppy/firmware/src/display_layout.c
// (fixed per element, never measured from text). They are only the editor's
// idea of where a box is -- the validator in the WebAssembly module is still
// the one rule set that decides whether a layout fits.

import type { ElementJson, LayoutJson } from './display-layout';

export const PANEL_W = 128;
const ADVANCE = 6;          // LAYOUT_ADVANCE: glyph 5 + 1 column
const LINE_H = 8;           // LAYOUT_LINE_H
const STATUS_MAX_CHARS = 8; // "DOWNLOAD"
const TRACK_MAX_CHARS = 5;  // "99/99"
const PCT_MAX_CHARS = 4;    // "100%"

export interface Box { x: number; y: number; w: number; h: number }

export function panelHeight(panel: LayoutJson['panel']): number {
  return panel === '128x64' ? 64 : 32;
}

/** The element's size in panel pixels, at its scale. */
export function elementSize(e: ElementJson): { w: number; h: number } {
  let w = 0;
  let h = LINE_H;
  switch (e.id) {
    case 'status': w = STATUS_MAX_CHARS * ADVANCE; break;
    case 'wifi': w = 11; break;
    case 'write': w = 8; break;
    case 'lemming': w = 8; break;
    case 'title': w = e.w; h = LINE_H * (e.opt ? e.opt : 1); break;
    case 'detail': w = e.w; break;
    case 'track': w = TRACK_MAX_CHARS * ADVANCE; break;
    case 'download': w = (e.w ? e.w + 2 : 0) + PCT_MAX_CHARS * ADVANCE; break;
  }
  const s = e.scale === 2 ? 2 : 1;
  return { w: w * s, h: h * s };
}

export function elementBox(e: ElementJson): Box {
  return { x: e.x, y: e.y, ...elementSize(e) };
}

/**
 * Index of the topmost VISIBLE element under (px, py), or -1. Drawing order is
 * list order, so the last one drawn is on top: search in reverse. A hidden
 * element draws nothing and so cannot be grabbed.
 */
export function hitTest(elements: readonly ElementJson[], px: number, py: number): number {
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (!e.visible) continue;
    const b = elementBox(e);
    if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) return i;
  }
  return -1;
}

/**
 * Where an element lands when asked to sit at (x, y): optionally snapped to
 * 8 px, always on even coordinates at 2x (every pixel is doubled), then clamped
 * so the whole box stays inside the panel. Clamping wins over snapping -- an
 * element against the right edge is better than one past it. An element wider
 * than the panel is pinned to 0 and left for the validator to name.
 */
export function placeElement(
  e: ElementJson, x: number, y: number, panel: LayoutJson['panel'], snap: boolean,
): { x: number; y: number } {
  const { w, h } = elementSize(e);
  const fit = (v: number, size: number, limit: number) => {
    let r = Math.round(v);
    if (snap) r = Math.round(r / 8) * 8;
    if (e.scale === 2) r = Math.round(r / 2) * 2;
    const max = Math.max(0, limit - size);
    // The panel's sides and a 2x size are both even, so max is even too:
    // clamping keeps a 2x coordinate even.
    return Math.min(Math.max(0, r), max);
  };
  return { x: fit(x, w, PANEL_W), y: fit(y, h, panelHeight(panel)) };
}

function intersects(a: Box, b: Box): boolean {
  return a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0
    && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Indices of visible elements whose box intersects another visible element's. */
export function overlapping(elements: readonly ElementJson[]): Set<number> {
  const out = new Set<number>();
  const boxes = elements.map(elementBox);
  for (let i = 0; i < elements.length; i++) {
    if (!elements[i].visible) continue;
    for (let j = i + 1; j < elements.length; j++) {
      if (!elements[j].visible) continue;
      if (intersects(boxes[i], boxes[j])) { out.add(i); out.add(j); }
    }
  }
  return out;
}
