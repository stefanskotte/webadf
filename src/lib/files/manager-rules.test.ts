import { describe, it, expect } from 'vitest';
import {
  dropBlocked, fetchDownload, opTitle, reloadsBoth, skippedItems, stashTitle, stripDiskOf, tallyItems, TOO_BIG_WORDS, BUSY_DROP, DIALOG_DROP,
} from './manager-rules';
import type { OpItem } from './driver';
import type { Listing } from './types';

const listing = (diskId: string | null): Listing => ({
  path: 'LIBRARY:/g/d', crumbs: [], entries: [], writable: true, readOnlyReason: null, meta: '',
  disk: diskId === null ? null : { diskId } as Listing['disk'],
});

describe('stripDiskOf (final review: an unreadable disk keeps its strip)', () => {
  it('the listed disk, else the disk the path is in when its image could not be read', () => {
    expect(stripDiskOf({ path: 'LIBRARY:/g/d', listing: listing('d'), error: null, gone: false })).toBe('d');
    expect(stripDiskOf({ path: 'LIBRARY:/g/d/C', listing: null, error: 'The disk image could not be read.', gone: false })).toBe('d');
  });
  it('none above the disks, and none for a place that is gone', () => {
    expect(stripDiskOf({ path: 'LIBRARY:/g', listing: listing(null), error: null, gone: false })).toBeNull();
    expect(stripDiskOf({ path: 'LIBRARY:/g', listing: null, error: 'x', gone: false })).toBeNull();
    expect(stripDiskOf({ path: 'LIBRARY:/g/d', listing: null, error: 'This place no longer exists.', gone: true })).toBeNull();
  });
});

describe('dropBlocked (final review: a drop never replaces an open dialog)', () => {
  it('refuses while an operation runs or a dialog is open, in words', () => {
    expect(dropBlocked({ busy: false, dialogOpen: false })).toBeNull();
    expect(dropBlocked({ busy: true, dialogOpen: false })).toBe(BUSY_DROP);
    expect(dropBlocked({ busy: false, dialogOpen: true })).toBe(DIALOG_DROP);
  });
});

describe('reloadsBoth (final review: a stale pane does not keep a dead entry)', () => {
  it('conflict and not_found refresh both panes; other refusals do not', () => {
    expect(reloadsBoth('conflict')).toBe(true);
    expect(reloadsBoth('not_found')).toBe(true);
    expect(reloadsBoth('disk_full')).toBe(false);
    expect(reloadsBoth(undefined)).toBe(false);
  });
});

describe('fetchDownload (final review: a refusal is words, never a saved error page)', () => {
  const fake = (res: Response) => async () => res;
  it('a 2xx brings the bytes and the name from content-disposition', async () => {
    const r = await fetchDownload('/x', fake(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-disposition': "attachment; filename*=UTF-8''It%27s%20%281%29.zip" },
    })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("It's (1).zip");
    expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('413 too_large reads as too big, with the cap', async () => {
    const r = await fetchDownload('/x', fake(Response.json({ error: 'too_large', detail: 'over 4 MB' }, { status: 413 })));
    expect(r).toEqual({ ok: false, words: TOO_BIG_WORDS });
    expect(TOO_BIG_WORDS).toMatch(/select fewer files \(4 MB\)/);
  });
  it('the sign-in page answered in its place (a 200 page, or a redirect) is words, never a saved file', async () => {
    expect(await fetchDownload('/x', fake(new Response('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))))
      .toEqual({ ok: false, words: 'Signed out — sign in again' });
    const moved = new Response('x', { headers: { 'content-type': 'application/octet-stream' } });
    Object.defineProperty(moved, 'redirected', { value: true });
    expect(await fetchDownload('/x', fake(moved))).toEqual({ ok: false, words: 'Signed out — sign in again' });
  });
  it('any other refusal is its code (the caller words it); a network failure is failed', async () => {
    expect(await fetchDownload('/x', fake(Response.json({ error: 'blob_unavailable' }, { status: 503 }))))
      .toEqual({ ok: false, code: 'blob_unavailable', detail: undefined });
    expect(await fetchDownload('/x', fake(new Response('<html>oops</html>', { status: 500 }))))
      .toEqual({ ok: false, code: undefined, detail: undefined });
    expect(await fetchDownload('/x', async () => { throw new TypeError('offline'); })).toEqual({ ok: false, code: 'failed', detail: undefined });
  });
});

describe('tallyItems and opTitle (final review: a skipped item is never counted as done)', () => {
  const ok = (source: string): OpItem => ({ source, ok: true });
  const skip = (source: string): OpItem => ({ source, ok: true, skipped: true });
  const bad = (source: string): OpItem => ({ source, ok: false, refusal: { code: 'failed' } });
  const said = (n: number) => `Moved ${n === 1 ? '1 item' : `${n} items`} to Disk 1.`;
  const count = (n: number) => (n === 1 ? '1 item' : `${n} items`);

  it('counts done, skipped and failed apart', () => {
    expect(tallyItems([ok('a'), skip('b'), skip('c'), bad('d')])).toEqual({ done: 1, skipped: 2, failed: 1 });
  });
  it('a Move whose only item was skipped says Skipped, not Moved', () => {
    expect(opTitle(tallyItems([skip('a')]), said, count)).toBe('Skipped 1 (already there).');
  });
  it('done and skipped: the done count excludes the skipped', () => {
    expect(opTitle(tallyItems([ok('a'), skip('b')]), said, count)).toBe('Moved 1 item to Disk 1. Skipped 1 (already there).');
  });
  it('with failures: what was done, what was skipped, then what could not be done', () => {
    expect(opTitle(tallyItems([ok('a'), skip('b'), bad('c')]), said, count))
      .toBe('Moved 1 item to Disk 1. Skipped 1 (already there). 1 item could not be done.');
    expect(opTitle(tallyItems([skip('b'), bad('c')]), said, count)).toBe('Skipped 1 (already there). 1 item could not be done.');
    expect(opTitle(tallyItems([bad('c')]), said, count)).toBe('Nothing was done.');
  });
  it('plain done is as before', () => {
    expect(opTitle(tallyItems([ok('a'), ok('b')]), said, count)).toBe('Moved 2 items to Disk 1.');
  });
  it('skippedItems: the sources a mixed answer never sent, as skipped results', () => {
    expect(skippedItems(['A', 'B', 'C'], { A: 'skip', B: 'replace', C: 'skip' })).toEqual([skip('A'), skip('C')]);
    expect(skippedItems(['A'], { A: 'replace' })).toEqual([]);
  });
});

describe('stashTitle (final review: a drop into STASH: never counts a skipped top as added)', () => {
  const count = (n: number) => (n === 1 ? '1 item' : `${n} items`);
  it('added only, as before', () => expect(stashTitle(3, 0, 'STASH:/Mods', count)).toBe('Added 3 items to STASH:/Mods'));
  it('added and skipped', () => expect(stashTitle(1, 2, 'STASH:', count)).toBe('Added 1 item to STASH:. Skipped 2 (already there).'));
  it('only skipped', () => expect(stashTitle(0, 1, 'STASH:', count)).toBe('Nothing was added. Skipped 1 (already there).'));
  it('nothing', () => expect(stashTitle(0, 0, 'STASH:', count)).toBe('Nothing was added.'));
});
