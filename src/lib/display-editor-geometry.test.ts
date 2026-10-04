import { describe, it, expect } from 'vitest';
import { elementSize, hitTest, placeElement, overlapping } from './display-editor-geometry';
import type { ElementJson } from './display-layout';

const el = (p: Partial<ElementJson> & Pick<ElementJson, 'id'>): ElementJson =>
  ({ visible: true, scale: 1, x: 0, y: 0, w: 0, opt: 0, ...p });

describe('elementSize mirrors layout_el_size', () => {
  it('fixed sizes at 1x', () => {
    expect(elementSize(el({ id: 'status' }))).toEqual({ w: 48, h: 8 });
    expect(elementSize(el({ id: 'wifi' }))).toEqual({ w: 11, h: 8 });
    expect(elementSize(el({ id: 'write' }))).toEqual({ w: 8, h: 8 });
    expect(elementSize(el({ id: 'lemming' }))).toEqual({ w: 8, h: 8 });
    expect(elementSize(el({ id: 'track' }))).toEqual({ w: 30, h: 8 });
  });
  it('title is w by 8 per line, detail w by 8, download bar + 2 + four chars', () => {
    expect(elementSize(el({ id: 'title', w: 100, opt: 2 }))).toEqual({ w: 100, h: 16 });
    expect(elementSize(el({ id: 'title', w: 100, opt: 0 }))).toEqual({ w: 100, h: 8 });
    expect(elementSize(el({ id: 'detail', w: 64 }))).toEqual({ w: 64, h: 8 });
    expect(elementSize(el({ id: 'download', w: 0 }))).toEqual({ w: 24, h: 8 });
    expect(elementSize(el({ id: 'download', w: 96 }))).toEqual({ w: 122, h: 8 });
  });
  it('doubles everything at 2x', () => {
    expect(elementSize(el({ id: 'title', w: 64, opt: 1, scale: 2 }))).toEqual({ w: 128, h: 16 });
    expect(elementSize(el({ id: 'track', scale: 2 }))).toEqual({ w: 60, h: 16 });
  });
});

describe('placeElement', () => {
  it('moves by whole pixels and clamps inside the panel', () => {
    const t = el({ id: 'track' });                 // 30x8
    expect(placeElement(t, 13.4, 5, '128x32', false)).toEqual({ x: 13, y: 5 });
    expect(placeElement(t, 200, 200, '128x32', false)).toEqual({ x: 98, y: 24 });
    expect(placeElement(t, -5, -5, '128x32', false)).toEqual({ x: 0, y: 0 });
    expect(placeElement(t, 200, 200, '128x64', false)).toEqual({ x: 98, y: 56 });
  });
  it('snaps to 8 px when asked', () => {
    expect(placeElement(el({ id: 'wifi' }), 13, 5, '128x32', true)).toEqual({ x: 16, y: 8 });
    expect(placeElement(el({ id: 'wifi' }), 11, 3, '128x32', true)).toEqual({ x: 8, y: 0 });
  });
  it('clamping wins over snapping', () => {
    // wifi is 11 wide: the last x that fits is 117, not a multiple of 8.
    expect(placeElement(el({ id: 'wifi' }), 127, 0, '128x32', true)).toEqual({ x: 117, y: 0 });
  });
  it('keeps a 2x element on even coordinates, clamped or not', () => {
    const t = el({ id: 'track', scale: 2 });       // 60x16
    expect(placeElement(t, 13, 7, '128x64', false)).toEqual({ x: 14, y: 8 });
    expect(placeElement(t, 500, 500, '128x64', false)).toEqual({ x: 68, y: 48 });
    const p = placeElement(el({ id: 'wifi', scale: 2 }), 300, 1, '128x32', false); // 22x16
    expect(p.x % 2).toBe(0);
    expect(p).toEqual({ x: 106, y: 2 });
  });
  it('pins an element larger than the panel to 0', () => {
    expect(placeElement(el({ id: 'title', w: 128, opt: 2, scale: 2 }), 10, 10, '128x32', false)).toEqual({ x: 0, y: 0 });
  });
});

describe('hitTest', () => {
  const els = [
    el({ id: 'detail', x: 0, y: 24, w: 128 }),
    el({ id: 'track', x: 98, y: 24 }),
    el({ id: 'wifi', x: 0, y: 0, visible: false }),
  ];
  it('returns the topmost (last drawn) element under the point', () => {
    expect(hitTest(els, 100, 25)).toBe(1);
    expect(hitTest(els, 10, 25)).toBe(0);
  });
  it('misses empty space and hidden elements; boxes are half-open', () => {
    expect(hitTest(els, 5, 3)).toBe(-1);
    expect(hitTest(els, 128, 25)).toBe(-1);
    expect(hitTest(els, 10, 32)).toBe(-1);
  });
});

describe('overlapping', () => {
  it('flags both elements of every intersecting visible pair', () => {
    const els = [
      el({ id: 'track', x: 98, y: 24 }),
      el({ id: 'download', x: 104, y: 24 }),
      el({ id: 'wifi', x: 0, y: 0 }),
      el({ id: 'status', x: 14, y: 0 }),
    ];
    expect([...overlapping(els)].sort()).toEqual([0, 1]);
  });
  it('ignores hidden elements and boxes that only touch', () => {
    const els = [
      el({ id: 'wifi', x: 0, y: 0 }),               // 0..11
      el({ id: 'write', x: 11, y: 0 }),             // touches at 11
      el({ id: 'lemming', x: 2, y: 2, visible: false }),
    ];
    expect(overlapping(els).size).toBe(0);
  });
});
