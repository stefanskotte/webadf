import { describe, it, expect } from 'vitest';
import { dropBlocked, fetchDownload, reloadsBoth, stripDiskOf, TOO_BIG_WORDS, BUSY_DROP, DIALOG_DROP } from './manager-rules';
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
