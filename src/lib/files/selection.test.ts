import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, moveCursor, selectClick, togglePick, type Selection } from './selection';

const none = { shift: false, toggle: false };
const picked = (s: Selection) => [...s.picked].sort((a, b) => a - b);

describe('selectClick', () => {
  it('a plain click picks only that row and sets the anchor', () => {
    const s = selectClick(selectClick(EMPTY_SELECTION, 2, none), 4, none);
    expect(picked(s)).toEqual([4]);
    expect(s).toMatchObject({ anchor: 4, cursor: 4 });
  });
  it('shift picks the range from the anchor, either direction', () => {
    const a = selectClick(EMPTY_SELECTION, 2, none);
    expect(picked(selectClick(a, 5, { shift: true, toggle: false }))).toEqual([2, 3, 4, 5]);
    expect(picked(selectClick(a, 0, { shift: true, toggle: false }))).toEqual([0, 1, 2]);
    expect(selectClick(a, 5, { shift: true, toggle: false }).anchor).toBe(2);
  });
  it('shift without an anchor acts as a plain click', () => {
    expect(picked(selectClick(EMPTY_SELECTION, 3, { shift: true, toggle: false }))).toEqual([3]);
  });
  it('toggle keeps the others and flips the row', () => {
    let s = selectClick(EMPTY_SELECTION, 1, none);
    s = selectClick(s, 3, { shift: false, toggle: true });
    expect(picked(s)).toEqual([1, 3]);
    s = selectClick(s, 1, { shift: false, toggle: true });
    expect(picked(s)).toEqual([3]);
    expect(s.cursor).toBe(1);
  });
  it('a plain click after a multi-selection resets it', () => {
    let s = selectClick(EMPTY_SELECTION, 1, none);
    s = selectClick(s, 4, { shift: true, toggle: false });
    expect(picked(selectClick(s, 7, none))).toEqual([7]);
  });
  it('does not mutate the previous selection', () => {
    const s = selectClick(EMPTY_SELECTION, 1, none);
    selectClick(s, 3, { shift: false, toggle: true });
    expect(picked(s)).toEqual([1]);
    expect(EMPTY_SELECTION.picked.size).toBe(0);
  });
});

describe('moveCursor', () => {
  const at = (i: number) => selectClick(EMPTY_SELECTION, i, none);
  it('moves and clamps at 0 and count-1', () => {
    expect(moveCursor(at(2), 1, 5, false).cursor).toBe(3);
    expect(moveCursor(at(0), -1, 5, false).cursor).toBe(0);
    expect(moveCursor(at(4), 1, 5, false).cursor).toBe(4);
    expect(moveCursor(at(2), 99, 5, false).cursor).toBe(4);
  });
  it('without extend the pick follows the cursor', () => {
    expect(picked(moveCursor(at(2), 1, 5, false))).toEqual([3]);
  });
  it('with extend the range grows from the anchor', () => {
    let s = moveCursor(at(2), 1, 5, true);
    s = moveCursor(s, 1, 5, true);
    expect(picked(s)).toEqual([2, 3, 4]);
    expect(s.anchor).toBe(2);
    expect(picked(moveCursor(s, -1, 5, true))).toEqual([2, 3]);
  });
  it('an empty list keeps the cursor at 0', () => {
    expect(moveCursor(EMPTY_SELECTION, 1, 0, false).cursor).toBe(0);
  });
});

describe('togglePick', () => {
  it('flips the row at the cursor without moving the others', () => {
    let s = selectClick(EMPTY_SELECTION, 1, none);
    s = togglePick(s, 3);
    expect(picked(s)).toEqual([1, 3]);
    expect(picked(togglePick(s, 1))).toEqual([3]);
  });
});
