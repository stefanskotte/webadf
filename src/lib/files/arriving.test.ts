import { describe, it, expect } from 'vitest';
import { STALL_MS, STASH_POLL_MS, STASH_STALLED_POLL_MS, stalledWords, stashPollMs, trackArriving, withStalls } from './arriving';
import type { FsEntry, Listing } from './types';

const row = (name: string, received: number | undefined, marks: string[]): FsEntry => ({
  name, kind: 'file', path: `STASH:/${name}`, size: 1000, date: null, protection: null, comment: null, marks, received,
});
const arriving = (name: string, received: number) => row(name, received, ['from A500', `arriving ${Math.floor(received / 10)}%`]);
const listing = (entries: FsEntry[], path = 'STASH:'): Listing =>
  ({ path, crumbs: [], entries, writable: true, readOnlyReason: null, disk: null, meta: '' });

describe('arriving rows in STASH:', () => {
  it('a row whose bytes moved (or is new) restarts its clock; one no longer arriving is forgotten', () => {
    let seen = trackArriving({}, [arriving('a', 100), arriving('b', 200), row('c', undefined, [])], 1000);
    expect(seen).toEqual({ 'STASH:/a': { bytes: 100, since: 1000 }, 'STASH:/b': { bytes: 200, since: 1000 } });
    seen = trackArriving(seen, [arriving('a', 100), arriving('b', 300)], 5000);
    expect(seen).toEqual({ 'STASH:/a': { bytes: 100, since: 1000 }, 'STASH:/b': { bytes: 300, since: 5000 } });
    expect(trackArriving(seen, [row('a', undefined, [])], 9000)).toEqual({});
  });

  it(`a row that has not moved for ${STALL_MS / 1000} s says it stopped, with what to do`, () => {
    const seen = trackArriving({}, [arriving('a', 400)], 0);
    const before = withStalls([arriving('a', 400)], seen, STALL_MS - 1);
    expect(before[0].marks).toEqual(['from A500', 'arriving 40%']);
    const after = withStalls([arriving('a', 400), row('c', undefined, ['x'])], seen, STALL_MS);
    expect(after[0].marks).toEqual(['from A500', 'Stopped at 40 % — send it again from the Amiga to continue']);
    expect(after[1].marks).toEqual(['x']);
    expect(stalledWords(7)).toBe('Stopped at 7 % — send it again from the Amiga to continue');
  });

  it('a STASH: pane polls fast while a row moves, slowly while all are stopped, and not at all with none arriving', () => {
    const l = listing([arriving('a', 100)]);
    const seen = trackArriving({}, l.entries, 0);
    expect(stashPollMs(l, seen, 1000)).toBe(STASH_POLL_MS);
    expect(stashPollMs(l, seen, STALL_MS)).toBe(STASH_STALLED_POLL_MS);
    expect(stashPollMs(listing([row('c', undefined, [])]), {}, 0)).toBeNull();
    expect(stashPollMs(null, {}, 0)).toBeNull();
    // Only STASH: polls for this; NET: has its own poll.
    expect(stashPollMs(listing([arriving('a', 100)], 'NET:/b1'), seen, 1000)).toBeNull();
  });
});
