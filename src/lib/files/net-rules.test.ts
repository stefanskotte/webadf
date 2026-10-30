import { describe, it, expect } from 'vitest';
import { netPollMs, planNetSend, NET_REFRESH_ACTIVE_MS, NET_REFRESH_IDLE_MS, readAgo, nextAsk, netTitle, isNetVolume, netBoardRoot, boardNameFor, NET_READ_ONLY, listingRefusal } from './net-rules';
import type { Listing } from './types';

const L = (path: string, marks: string[][] = []): Listing => ({ path, crumbs: [], writable: true, readOnlyReason: null, disk: null, meta: '',
  entries: marks.map((m, i) => ({ name: `f${i}`, kind: 'file', path: `${path}/t${i}`, size: 1, date: null, protection: null, comment: null, marks: m })) });

describe('netPollMs', () => {
  it('polls a board queue fast while something waits or sends, slowly otherwise, and nothing elsewhere', () => {
    expect(NET_REFRESH_ACTIVE_MS).toBe(3_000);
    expect(NET_REFRESH_IDLE_MS).toBe(10_000);
    expect(netPollMs(L('NET:/b1/Queue', [['Waiting']]))).toBe(3_000);
    // C6: the sending text carries its percentage, so the rule must not match exact words only.
    expect(netPollMs(L('NET:/b1/Queue', [['Delivered · saved as a.txt'], ['Sending 40 %']]))).toBe(3_000);
    expect(netPollMs(L('NET:/b1/Queue', [['Delivered · saved as a.txt'], ['Cancelled'], ['Expired · the Amiga did not take it within 24 h']]))).toBe(10_000);
    expect(netPollMs(L('NET:/b1/Queue'))).toBe(10_000);
    // NET: volumes (spec 2026-10-30): a board's root and its volumes are read on request, never polled.
    expect(netPollMs(L('NET:/b1', [['Waiting']]))).toBeNull();
    expect(netPollMs(L('NET:/b1/Work/Programs', [['Waiting']]))).toBeNull();
    expect(netPollMs(L('NET:'))).toBeNull();
    expect(netPollMs(L('STASH:'))).toBeNull();
    expect(netPollMs(L('LIBRARY:/g1/d1'))).toBeNull();
    expect(netPollMs(null)).toBeNull();
  });
});

describe('planNetSend', () => {
  const MB = 1024 * 1024;
  it('fits, or names why not', () => {
    expect(planNetSend([MB, MB], { files: 30, bytes: 0 })).toEqual({ ok: true });
    expect(planNetSend([MB, MB, MB], { files: 30, bytes: 0 })).toEqual({ ok: false, why: 'queue_full' });
    expect(planNetSend([10 * MB], { files: 0, bytes: 7 * MB })).toEqual({ ok: false, why: 'queue_full' });
    expect(planNetSend([MB, 5 * MB], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'too_large', index: 1 });
    expect(planNetSend([0], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'empty', index: 0 });
    expect(planNetSend([], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'empty' });
  });
  it('takes exactly 4 MB a file and exactly 32 files / 16 MB a board', () => {
    expect(planNetSend([4 * MB], { files: 0, bytes: 12 * MB })).toEqual({ ok: true });
    expect(planNetSend([4 * MB + 1], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'too_large', index: 0 });
    expect(planNetSend([1, 1], { files: 30, bytes: 0 })).toEqual({ ok: true });
  });
});

describe('NET: volumes in the pane (spec 2026-10-30 §5)', () => {
  const net = (o: Partial<NonNullable<Listing['net']>> = {}) => ({ board: 'd', boardName: 'A500', volume: 'Work', amigaPath: 'Work:Programs', readAt: null, cut: false, browse: null, ...o });
  it('readAgo', () => {
    expect(readAgo(null, 1000)).toBeNull();
    expect(readAgo(1000, 3000)).toBeNull();
    expect(readAgo(0, 4_999)).toBeNull();
    expect(readAgo(0, 5_000)).toBe('read 5 s ago');
    expect(readAgo(0, 40_000)).toBe('read 40 s ago');
    expect(readAgo(0, 59_999)).toBe('read 59 s ago');
    expect(readAgo(0, 60_000)).toBe('read 1 min ago');
    expect(readAgo(0, 125_000)).toBe('read 2 min ago');
  });
  it('nextAsk gives up after 20 s', () => {
    expect(nextAsk(0, 0)).toBe('ask');
    expect(nextAsk(0, 19_999)).toBe('ask');
    expect(nextAsk(0, 20_000)).toBe('give-up');
  });
  it('netTitle', () => {
    expect(netTitle({ net: net() } as never)).toBe('A500 · Work:Programs');
    expect(netTitle({ net: net({ volume: null, amigaPath: null }) } as never)).toBeNull();
    expect(netTitle(L('STASH:'))).toBeNull();
  });
  it('isNetVolume: a volume or a drawer in one, never the board, its Queue or NET:', () => {
    expect(NET_READ_ONLY).toBe('Read-only for now');
    expect(isNetVolume({ ...L('NET:/d/Work/Programs'), net: net() })).toBe(true);
    expect(isNetVolume({ ...L('NET:/d/Work'), net: net({ amigaPath: 'Work:' }) })).toBe(true);
    expect(isNetVolume({ ...L('NET:/d'), net: net({ volume: null, amigaPath: null }) })).toBe(false);
    expect(isNetVolume(L('NET:/d/Queue'))).toBe(false);
    expect(isNetVolume(L('NET:'))).toBe(false);
    expect(isNetVolume(null)).toBe(false);
  });
  it('netBoardRoot: the board of NET:/<board> only', () => {
    expect(netBoardRoot('NET:/d')).toBe('d');
    expect(netBoardRoot('NET:/d/Queue')).toBeNull();
    expect(netBoardRoot('NET:/d/Work')).toBeNull();
    expect(netBoardRoot('NET:')).toBeNull();
    expect(netBoardRoot('STASH:/d')).toBeNull();
  });
  it('boardNameFor: the name a listing on screen gives the board, else its id', () => {
    expect(boardNameFor('NET:/d/Work', { ...L('NET:/d'), net: net({ volume: null, amigaPath: null }) })).toBe('A500');
    const boards = { ...L('NET:'), entries: [{ name: 'A1200', kind: 'board' as const, path: 'NET:/d', size: null, date: null, protection: null, comment: null, marks: [] }] };
    expect(boardNameFor('NET:/d', boards)).toBe('A1200');
    expect(boardNameFor('NET:/d/Work', { ...L('NET:/e'), net: net({ board: 'e' }) })).toBe('d');
    expect(boardNameFor('NET:/d', null)).toBe('d');
    // Opened straight at a volume, nothing on screen names the board: the page's boards do (Task 9 e2e).
    expect(boardNameFor('NET:/d/Work', null, [{ id: 'e', name: 'A1200' }, { id: 'd', name: 'A500' }])).toBe('A500');
    expect(boardNameFor('NET:/d/Work', { ...L('NET:/d'), net: net({ volume: null, amigaPath: null }) }, [{ id: 'd', name: 'Old' }])).toBe('A500');
  });
});

// Final review: in-app navigation to a NET: drawer the Amiga refused (notfound/notdir, 404 with its words) shows the
// words, not "This place no longer exists."; every other 404 or 400 is still a place gone.
describe('listingRefusal', () => {
  it('a NET: 404 with words is a refusal in those words', () => {
    expect(listingRefusal('NET:/b1/Work/Gone', 404, 'Object not found')).toEqual({ words: 'Object not found' });
  });
  it('a 404 or 400 without words, or on another device, is gone', () => {
    expect(listingRefusal('NET:/b1', 404, undefined)).toEqual({ gone: true });
    expect(listingRefusal('NET:/b1/Work', 400, 'bad')).toEqual({ gone: true });
    expect(listingRefusal('STASH:/Gone', 404, 'Object not found')).toEqual({ gone: true });
    expect(listingRefusal('LIBRARY:/g1', 404, undefined)).toEqual({ gone: true });
  });
  it('other refusals: a NET: detail is the whole sentence; elsewhere the code\'s words decide (null)', () => {
    expect(listingRefusal('NET:/b1/Work', 409, 'Switch on browsing in Transfer on A500')).toEqual({ words: 'Switch on browsing in Transfer on A500' });
    expect(listingRefusal('STASH:/x', 409, 'whatever')).toEqual({ words: null });
    expect(listingRefusal('NET:/b1/Work', 504, undefined)).toEqual({ words: null });
  });
});
