import { describe, it, expect } from 'vitest';
import {
  SELECTION_CAP, canSelectPage, countText, initSelection, offPageCount, offPageText, pageCheck, selectionReducer,
  titlesWord, disksWord, moveToast, deleteToast, keptIntro, keptLine, keptGroups, viewKeyOf, reconcileSelection, isFormControl, type PageTitle, type SelectionState,
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

  it('a checkbox or radio holds no text: Escape from the bar\'s own box or a card\'s box still ends selecting', () => {
    expect(isFormControl({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isFormControl({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isFormControl({ tagName: 'INPUT', type: 'text' })).toBe(true);
  });
});

describe('move words (spec §2.3)', () => {
  it('names how many went where, and adds what was already there or already gone', () => {
    expect(moveToast({ added: 12, alreadyThere: 0, removedFrom: 0, missing: [] }, 'Shooters')).toBe('Moved 12 titles to Shooters');
    expect(moveToast({ added: 9, alreadyThere: 3, removedFrom: 9, missing: [] }, 'X')).toBe('Moved 12 titles to X, 3 were already there');
    expect(moveToast({ added: 1, alreadyThere: 1, removedFrom: 0, missing: ['g'] }, 'X'))
      .toBe('Moved 2 titles to X, 1 was already there, 1 was already gone');
  });
});

describe('delete words (spec §2.2, §2.3)', () => {
  const kept = { id: 'k', title: 'Turrican', holds: [{ deviceName: 'A500', drive: 'DF0' as const, label: 'In A500' },
    { deviceName: 'A1200', drive: 'DF1' as const, label: 'In A1200' }] };
  const drift = { id: 'd', title: 'Lotus III', holds: [] };
  it('a kept title says where it is, drive by drive', () => {
    expect(keptLine(kept)).toBe('Turrican — In A500 (DF0) · In A1200 (DF1)');
    expect(keptIntro(1)).toBe('1 title is in a drive and will be kept:');
    expect(keptIntro(2)).toBe('2 titles are in a drive and will be kept:');
  });
  it('a title the drift guard kept (no holds) is never described as in a drive', () => {
    expect(keptLine(drift)).toBe('Lotus III — could not be deleted');
    const g = keptGroups([kept, drift]);
    expect(g.held).toEqual([kept]);
    expect(g.stuck).toEqual([drift]);
  });
  it('the toast counts what went, and says what was kept, already gone or ejected', () => {
    const base = { deleted: ['a', 'b'], diskIds: [], kept: [], missing: [], ejected: [], releasedSha256: [] };
    expect(deleteToast(base)).toEqual({ title: 'Deleted 2 titles', description: undefined });
    expect(deleteToast({ ...base, kept: [kept, { ...kept, id: 'l', title: 'Lotus II' }], missing: ['m'], ejected: ['A500'] })).toEqual({
      title: 'Deleted 2 titles',
      description: 'Kept 2 that are in a drive: Turrican, Lotus II. 1 was already gone. Ejected from A500.',
    });
    expect(deleteToast({ ...base, kept: [drift] }).description).toBe('1 could not be deleted: Lotus III.');
    expect(deleteToast({ ...base, deleted: [], kept: [kept] }).title).toBe('Nothing was deleted');
  });
});
