import { describe, it, expect } from 'vitest';
import { planEdit, groupOf, EditError, GROUP_COLUMN } from '@/lib/game-edit';

const current = {
  title: 'Turrican II',
  year: 1991,
  publisher: 'Rainbow Arts',
  developer: null,
  players: null,
  genre: null,
  chipset: null,
  description: null,
  history: null,
};

describe('planEdit', () => {
  it('stamps only the group a change actually belongs to', () => {
    const plan = planEdit({ description: 'A run and gun.' }, current);
    expect(plan.touched).toEqual(['prose']);
    expect(plan.values).toEqual({ description: 'A run and gun.' });
  });

  it('does not stamp a group whose value did not change', () => {
    // The whole form is submitted every time; only real changes may count.
    // Otherwise merely opening the editor freezes every group on the row
    // against all future scans.
    const plan = planEdit(
      { title: 'Turrican II', year: 1991, publisher: 'Rainbow Arts', genre: 'shooter' },
      current,
    );
    expect(plan.touched).toEqual(['facts']);
    expect(plan.values).toEqual({ genre: 'shooter' });
  });

  it('stamps nothing at all when nothing changed', () => {
    const plan = planEdit({ title: 'Turrican II', year: 1991, publisher: 'Rainbow Arts' }, current);
    expect(plan.touched).toEqual([]);
    expect(plan.values).toEqual({});
  });

  it('derives sortTitle whenever the title changes', () => {
    // sortTitle is NOT NULL, orders games_org_sort_idx, and is half the key
    // mergeDuplicates collapses on -- a title edit that skipped it would
    // leave the row sorting and merging under its old name.
    const plan = planEdit({ title: 'The Secret of Monkey Island' }, current);
    expect(plan.values.title).toBe('The Secret of Monkey Island');
    expect(plan.values.sortTitle).toBe('secret of monkey island, the');
    expect(plan.touched).toEqual(['identity']);
  });

  it('touches several groups when an edit spans them', () => {
    const plan = planEdit({ publisher: 'Factor 5', genre: 'shooter', history: 'Ported widely.' }, current);
    expect(plan.touched).toEqual(['identity', 'facts', 'prose']);
  });

  it('treats an emptied box as "no value", not as an empty string', () => {
    const plan = planEdit({ publisher: '   ' }, { ...current, publisher: 'Rainbow Arts' });
    expect(plan.values).toEqual({ publisher: null });
    expect(plan.touched).toEqual(['identity']);
  });

  it('does not count whitespace as a change', () => {
    const plan = planEdit({ publisher: '  Rainbow Arts  ' }, current);
    expect(plan.touched).toEqual([]);
  });

  it('refuses an empty title, because sortTitle derives from it', () => {
    expect(() => planEdit({ title: '   ' }, current)).toThrow(EditError);
  });

  it('refuses a year that cannot be one', () => {
    expect(() => planEdit({ year: 1492 }, current)).toThrow(EditError);
    expect(() => planEdit({ year: 2999 }, current)).toThrow(EditError);
    expect(() => planEdit({ year: 1991.5 }, current)).toThrow(EditError);
  });

  it('accepts a cleared year', () => {
    const plan = planEdit({ year: null }, current);
    expect(plan.values).toEqual({ year: null });
    expect(plan.touched).toEqual(['identity']);
  });

  it('ignores keys that are not editable fields', () => {
    // id, orgId and the source columns themselves must never be settable by
    // a request body.
    const plan = planEdit({ id: 'x', orgId: 'y', metadataSource: 'tosec' } as never, current);
    expect(plan.values).toEqual({});
    expect(plan.touched).toEqual([]);
  });
});

describe('the group map', () => {
  it('puts publisher in identity, not facts', () => {
    // OpenRetro writes publisher too, but it is TOSEC's column first and a
    // person correcting it means it -- so openretro-apply guards its
    // publisher write on metadataSource.
    expect(groupOf('publisher')).toBe('identity');
    expect(GROUP_COLUMN.identity).toBe('metadataSource');
  });

  it('separates facts from prose', () => {
    expect(groupOf('genre')).toBe('facts');
    expect(groupOf('description')).toBe('prose');
    expect(GROUP_COLUMN.facts).toBe('factsSource');
    expect(GROUP_COLUMN.prose).toBe('proseSource');
  });

  it('does not expose sortTitle as editable', () => {
    expect(groupOf('sortTitle')).toBeNull();
  });
});
