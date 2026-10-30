import { describe, it, expect } from 'vitest';
import { Pending, Refused } from './driver';
import { firstFromThrown } from './first-listing';

// The Files page's first listing (page.tsx): what a pane opens with when its place throws instead of listing.
describe('firstFromThrown', () => {
  it('a NET: listing the Amiga has not answered opens pending with its label (NET: volumes, spec 2026-10-30 §4.4)', () => {
    expect(firstFromThrown(new Pending('Reading Work:Programs from A500…'), 'NET'))
      .toEqual({ listing: null, pending: 'Reading Work:Programs from A500…' });
  });
  it('a NET: refusal opens with its words, else the refusal\'s own words', () => {
    expect(firstFromThrown(new Refused({ code: 'read_only', detail: 'Switch on browsing in Transfer on A500' }, 409), 'NET'))
      .toEqual({ listing: null, error: 'Switch on browsing in Transfer on A500' });
    expect(firstFromThrown(new Refused({ code: 'not_found', detail: 'Object not found' }, 404), 'NET'))
      .toEqual({ listing: null, error: 'Object not found' });
    expect(firstFromThrown(new Refused({ code: 'failed' }, 504), 'NET')!.error).toEqual(expect.any(String));
  });
  it('an unreadable image or archive keeps its words (and the disk it named); anything else is thrown on', () => {
    expect(firstFromThrown(new Refused({ code: 'blob_unavailable', detail: 'd1' }, 503), 'LIBRARY'))
      .toMatchObject({ listing: null, errorDisk: 'd1', error: expect.any(String) });
    expect(firstFromThrown(new Refused({ code: 'archive_unreadable' }, 422), 'STASH')).toMatchObject({ listing: null, errorDisk: undefined });
    expect(firstFromThrown(new Refused({ code: 'read_only' }, 409), 'LIBRARY')).toBeNull();
    expect(firstFromThrown(new Error('db down'), 'NET')).toBeNull();
  });
});
