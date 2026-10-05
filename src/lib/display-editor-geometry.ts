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

/**
 * Where the right-aligned text of a track/download element can start at the
 * earliest (its longest text): the box's left edge for track, just past the
 * bar for download. display.c right_text() with the widest string.
 */
function textMinLeft(o: ElementJson): number {
  const s = o.scale === 2 ? 2 : 1;
  return o.id === 'download' && o.w ? o.x + (o.w + 2) * s : o.x;
}

/**
 * Whether display_render() itself keeps a detail line off a track/download
 * element on its rows: detail is clipped one ADVANCE (at the detail's scale)
 * before the number's first pixel -- but only when that point lies to the
 * right of the detail's x, and a download BAR is never protected (the clip
 * is against the percent text only). Checked against the longest text, so
 * "resolved" holds in every state.
 */
function detailClipped(detail: ElementJson, o: ElementJson): boolean {
  const ds = detail.scale === 2 ? 2 : 1;
  if (textMinLeft(o) - ADVANCE * ds <= detail.x) return false;
  if (o.id === 'download' && o.w) {
    const bar: Box = { x: o.x, y: o.y, w: o.w * (o.scale === 2 ? 2 : 1), h: elementSize(o).h };
    if (intersects(elementBox(detail), bar)) return false;
  }
  return true;
}

/**
 * Overlaps the renderer does NOT resolve (Controller Ruling L). Two cases
 * display_render() resolves on its own and are not outlined:
 *   - track and download intersecting: the counter wins, download is not drawn;
 *   - detail beside a track/download number on its rows, number to the right:
 *     detail is clipped before it.
 * Every other intersecting pair of visible elements is a real overlap.
 */
function resolvedByRenderer(a: ElementJson, b: ElementJson): boolean {
  const ids = new Set([a.id, b.id]);
  if (ids.has('track') && ids.has('download')) return true;
  if (ids.has('detail') && (ids.has('track') || ids.has('download'))) {
    return a.id === 'detail' ? detailClipped(a, b) : detailClipped(b, a);
  }
  return false;
}

/** Indices of visible elements in an overlap the renderer does not resolve. */
export function overlapping(elements: readonly ElementJson[]): Set<number> {
  const out = new Set<number>();
  const boxes = elements.map(elementBox);
  for (let i = 0; i < elements.length; i++) {
    if (!elements[i].visible) continue;
    for (let j = i + 1; j < elements.length; j++) {
      if (!elements[j].visible) continue;
      if (!intersects(boxes[i], boxes[j])) continue;
      if (resolvedByRenderer(elements[i], elements[j])) continue;
      out.add(i); out.add(j);
    }
  }
  return out;
}

/** The device fields statusLine reads (a structural slice of DeviceListItem). */
export interface DisplayStatusFields {
  displayLayouts: boolean;
  displayVersion: number;
  displayAppliedVersion: number | null;
  displayError: string | null;
}

/**
 * Both values of "did the board take it", never an absent line standing in
 * for one of them.
 *
 * The board's verdict -- applied OR rejected -- is only about the version it
 * last HANDLED, so it is shown only once that is the current version
 * (displayAppliedVersion === displayVersion). Final review I2: a save clears
 * displayError (Ruling K), but the board keeps reporting its last reason in
 * every status until it handles the new version, and that report writes it
 * back -- so an error alongside an OLDER applied version is the previous
 * layout's refusal, not this one's: "Waiting", never "rejected". Among the
 * current version's verdicts the rejection wins: a board that refused a
 * version has handled it, so applied === version alone would read as success.
 */
export function statusLine(device: DisplayStatusFields): { text: string; warn: boolean } {
  if (!device.displayLayouts) return { text: 'Needs firmware 1.7.0 or newer', warn: true };
  if (device.displayAppliedVersion !== device.displayVersion) {
    return { text: 'Waiting for the board', warn: false };
  }
  if (device.displayError) return { text: `The board rejected it: ${device.displayError}`, warn: true };
  return { text: 'Applied on the board', warn: false };
}
