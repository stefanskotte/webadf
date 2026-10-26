import { describe, it, expect } from 'vitest';
import {
  SELECTION_CAP, canSelectPage, countText, initSelection, offPageCount, offPageText, pageCheck, selectionReducer,
  titlesWord, disksWord, viewKeyOf, reconcileSelection, isFormControl, type PageTitle, type SelectionState,
} from './library-selection';

const t = (id: string): PageTitle => ({ id, title: `T ${id}`, year: 1990, diskCount: 1 });
const on = (s: SelectionState) => selectionReducer(s, { type: 'start' });
const ids = (s: SelectionState) => [...s.selected.keys()];

describe('library selection (spec §1.5, §8 unit)', () => {
  it('the view key names one view: a collection, All titles or Uncategorized', () => {
    expect(viewKeyOf({ kind: 'uncategorized' })).toBe('uncategorized');
    expect(viewKeyOf({ kind: 'all' })).toBe('all');
    expect(viewKeyOf({ kind: 'collection', id: 'c1' })).toBe('collection:c1');
  });

  it('starts off; start turns selecting on with nothing selected; toggling before start does nothing', () => {
    const s = initSelection('all');
    expect(s).toEqual({ viewKey: 'all', selecting: false, selected: new Map() });
    expect(selectionReducer(s, { type: 'toggle', title: t('a') })).toBe(s);
    expect(on(s).selecting).toBe(true);
  });

  it('toggle adds then removes, keeping insertion order and the title facts', () => {
    let s = on(initSelection('all'));
    s = selectionReducer(s, { type: 'toggle', title: t('b') });
    s = selectionReducer(s, { type: 'toggle', title: t('a') });
    expect(ids(s)).toEqual(['b', 'a']);
    expect(s.selected.get('a')).toEqual({ title: 'T a', year: 1990, diskCount: 1 });
    s = selectionReducer(s, { type: 'toggle', title: t('b') });
    expect(ids(s)).toEqual(['a']);
  });

  it('cancel clears and ends selecting; a new view key clears it, the same key keeps it', () => {
    let s = selectionReducer(on(initSelection('all')), { type: 'toggle', title: t('a') });
    expect(selectionReducer(s, { type: 'view', viewKey: 'all' })).toBe(s);
    expect(selectionReducer(s, { type: 'view', viewKey: 'collection:c1' })).toEqual(initSelection('collection:c1'));
    s = selectionReducer(s, { type: 'cancel' });
    expect(s).toEqual(initSelection('all'));
  });

  it('the page select-all: none, some (indeterminate), all; it toggles exactly the page', () => {
    const page = [t('a'), t('b'), t('c')];
    let s = selectionReducer(on(initSelection('all')), { type: 'toggle', title: t('x') });   // off this page
    expect(pageCheck(s.selected, ['a', 'b', 'c'])).toBe('none');
    s = selectionReducer(s, { type: 'toggle', title: t('a') });
    expect(pageCheck(s.selected, ['a', 'b', 'c'])).toBe('some');
    s = selectionReducer(s, { type: 'togglePage', page });
    expect(pageCheck(s.selected, ['a', 'b', 'c'])).toBe('all');
    expect(ids(s)).toEqual(['x', 'a', 'b', 'c']);
    s = selectionReducer(s, { type: 'togglePage', page });
    expect(ids(s)).toEqual(['x']);
    expect(pageCheck(new Map(), [])).toBe('none');
  });

  it('caps a selection at 1,000: one more title, or a page that would pass it, is refused', () => {
    let s = on(initSelection('all'));
    s = selectionReducer(s, { type: 'togglePage', page: Array.from({ length: SELECTION_CAP - 1 }, (_, i) => t(`g${i}`)) });
    expect(s.selected.size).toBe(999);
    expect(canSelectPage(s.selected, ['p1', 'p2'])).toBe(false);
    expect(selectionReducer(s, { type: 'togglePage', page: [t('p1'), t('p2')] })).toBe(s);
    s = selectionReducer(s, { type: 'toggle', title: t('last') });
    expect(s.selected.size).toBe(1000);
    expect(selectionReducer(s, { type: 'toggle', title: t('over') })).toBe(s);
    expect(selectionReducer(s, { type: 'toggle', title: t('last') }).selected.size).toBe(999);   // unticking still works
  });

  it('counts the selected titles that are not on this page', () => {
    const s = new Map([['a', t('a')], ['x', t('x')], ['y', t('y')]]);
    expect(offPageCount(s, ['a', 'b'])).toBe(2);
    expect(offPageCount(s, ['a', 'x', 'y'])).toBe(0);
  });

  it('the words', () => {
    expect(countText(0)).toBe('No titles selected');
    expect(countText(1)).toBe('1 title selected');
    expect(countText(1200)).toBe('1,200 titles selected');
    expect(offPageText(4)).toBe(' · 4 on other pages');
    expect(titlesWord(1)).toBe('1 title');
    expect(disksWord(19)).toBe('19 disks');
  });

  it('an empty page toggled is a no-op: the same state back', () => {
    const s = on(initSelection('all'));
    expect(selectionReducer(s, { type: 'togglePage', page: [] })).toBe(s);
  });

  it('reconcile: a view that stops showing titles drops the selection; otherwise the state is kept', () => {
    const s = selectionReducer(on(initSelection('all')), { type: 'toggle', title: t('a') });
    expect(reconcileSelection(s, 'all', true)).toBe(s);
    expect(reconcileSelection(s, 'all', false)).toEqual(initSelection('all'));
    expect(reconcileSelection(s, 'collection:c1', true)).toEqual(initSelection('collection:c1'));
    const off = initSelection('all');
    expect(reconcileSelection(off, 'all', false)).toBe(off);
  });

  it('Escape in a native form control is that control\'s, not the selection\'s', () => {
    expect(isFormControl({ tagName: 'SELECT' })).toBe(true);
    expect(isFormControl({ tagName: 'INPUT' })).toBe(true);
    expect(isFormControl({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isFormControl({ tagName: 'BUTTON' })).toBe(false);
    expect(isFormControl(null)).toBe(false);
  });
});
