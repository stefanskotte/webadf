import { describe, it, expect } from 'vitest';
import { planReorder } from './collection-order';

/** Shorthand: assert success and return the assignments. */
function ok(current: string[], submitted: string[]) {
  const r = planReorder(current, submitted);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.assignments;
}

describe('planReorder', () => {
  it('numbers a reordered list from zero, in submitted order', () => {
    expect(ok(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([
      { id: 'c', sortKey: 0 },
      { id: 'a', sortKey: 1 },
      { id: 'b', sortKey: 2 },
    ]);
  });

  it('accepts an unchanged order', () => {
    // Dragging an item and dropping it back where it started is an ordinary
    // gesture; it must not be an error.
    expect(ok(['a', 'b'], ['a', 'b'])).toEqual([
      { id: 'a', sortKey: 0 },
      { id: 'b', sortKey: 1 },
    ]);
  });

  it('handles an empty collection', () => {
    expect(ok([], [])).toEqual([]);
  });

  it('REJECTS an id that is not a member', () => {
    // D-4-4. This is what makes it safe to accept a whole list from a
    // client: a reorder must never be a way to ADD a game.
    expect(planReorder(['a', 'b'], ['a', 'b', 'intruder']))
      .toEqual({ ok: false, reason: 'unknown-id', id: 'intruder' });
  });

  it('REJECTS a duplicated id', () => {
    // Two rows for one game would violate the primary key; catching it here
    // means the batch never runs rather than aborting halfway.
    expect(planReorder(['a', 'b'], ['a', 'a']))
      .toEqual({ ok: false, reason: 'duplicate-id', id: 'a' });
  });

  it('REJECTS a list that omits an existing member', () => {
    // Deliberately strict: treating an omission as a removal would make a
    // dropped element in a client-side drag silently delete a game from a
    // collection, which is unrecoverable work.
    expect(planReorder(['a', 'b', 'c'], ['a', 'b']))
      .toEqual({ ok: false, reason: 'missing-id', id: 'c' });
  });

  it('reports the FIRST offending id, deterministically', () => {
    // So the same bad request always produces the same error, whatever the
    // iteration order of the underlying sets.
    expect(planReorder(['a', 'b'], ['x', 'y']))
      .toEqual({ ok: false, reason: 'unknown-id', id: 'x' });
  });

  it('is not fooled by a list of the right LENGTH with the wrong members', () => {
    // The cheap check -- comparing lengths -- passes here. Only membership
    // comparison catches it.
    expect(planReorder(['a', 'b'], ['a', 'z']))
      .toEqual({ ok: false, reason: 'unknown-id', id: 'z' });
  });
});
