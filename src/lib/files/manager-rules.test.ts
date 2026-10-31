import { describe, it, expect } from 'vitest';
import {
  asksBeforeCopy, createClosesDialog, dropBlocked, fetchStatus, jobStatus, navTargets, pickGone, fetchDownload, oneAtATime, opTitle, reloadsBoth, skippedItems, stashTitle, stripDiskOf, tallyItems, TOO_BIG_WORDS, BUSY_DROP, DIALOG_DROP,
} from './manager-rules';
import type { OpItem } from './driver';
import type { Listing } from './types';

const listing = (diskId: string | null): Listing => ({
  path: 'LIBRARY:/g/d', crumbs: [], entries: [], writable: true, readOnlyReason: null, meta: '',
  disk: diskId === null ? null : { diskId } as Listing['disk'],
});

describe('stripDiskOf (an unreadable disk keeps its strip; Files 2 R2: by id, not by path)', () => {
  it('the listing\'s disk, else the id the refusal named', () => {
    expect(stripDiskOf({ listing: listing('d'), errorDisk: null })).toBe('d');
    expect(stripDiskOf({ listing: null, errorDisk: 'd4' })).toBe('d4');
  });
  it('none above the disks, and none for a failure that named no disk', () => {
    expect(stripDiskOf({ listing: listing(null), errorDisk: null })).toBeNull();
    expect(stripDiskOf({ listing: null, errorDisk: null })).toBeNull();
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

describe('Create ADF…: the dialog closes only on a made disk (Task 7 review)', () => {
  const ok: OpItem = { source: 'STASH:/Work.adf', ok: true };
  it('closes when the item was made (or skipped by the clash setting)', () => {
    expect(createClosesDialog({ kind: 'done', items: [ok] })).toBe(true);
    expect(createClosesDialog({ kind: 'done', items: [{ ...ok, skipped: true }] })).toBe(true);
  });
  it('stays open, the name in its field, when the item is refused, the op refused or a clash came back', () => {
    expect(createClosesDialog({ kind: 'done', items: [{ source: 'x', ok: false, refusal: { code: 'disk_full' } }] })).toBe(false);
    expect(createClosesDialog({ kind: 'done', items: [] })).toBe(false);
    expect(createClosesDialog({ kind: 'refused' })).toBe(false);
    expect(createClosesDialog({ kind: 'clashes' })).toBe(false);
  });
});

describe('oneAtATime (Enter and a click cannot submit twice)', () => {
  it('runs one call at a time and refuses the rest until it settles', async () => {
    let finish!: () => void;
    let runs = 0;
    const go = () => { runs++; return new Promise<void>((r) => { finish = r; }); };
    const once = oneAtATime();
    expect(once(go)).toBe(true);
    expect(once(go)).toBe(false);
    expect(runs).toBe(1);
    finish();
    await Promise.resolve(); await Promise.resolve();
    expect(once(go)).toBe(true);
    expect(runs).toBe(2);
  });
  it('lets go after a failed run too', async () => {
    const once = oneAtATime();
    expect(once(() => Promise.reject(new Error('x')))).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(once(() => Promise.resolve())).toBe(true);
  });
});

describe('navTargets (Parent and Root; Task 8 review: from the path when an error left nothing listed)', () => {
  const crumbs = (...paths: string[]) => paths.map((path) => ({ label: path, path }));
  it('from the listing\'s crumbs', () => {
    const l = { crumbs: crumbs('LIBRARY:', 'LIBRARY:/c', 'LIBRARY:/c/g') };
    expect(navTargets(l, 'LIBRARY:/c/g')).toEqual({ parent: 'LIBRARY:/c', root: 'LIBRARY:' });
    expect(navTargets({ crumbs: crumbs('STASH:') }, 'STASH:')).toEqual({ parent: null, root: null });
  });
  it('an errored pane (no listing) goes up from its path: Root works from a deep place', () => {
    expect(navTargets(null, 'STASH:/a/b/c')).toEqual({ parent: 'STASH:/a/b', root: 'STASH:' });
    expect(navTargets(null, 'LIBRARY:/g')).toEqual({ parent: 'LIBRARY:', root: 'LIBRARY:' });
    expect(navTargets(null, 'NET:')).toEqual({ parent: null, root: null });
    expect(navTargets(null, 'nonsense')).toEqual({ parent: null, root: null });
  });
});

describe('fetchStatus (NET: volumes §4.5: the status row of a copy out of a volume)', () => {
  it('fetchStatus counts up and ends with a summary', () => {
    expect(fetchStatus({ total: 12, done: 2, failed: [], waiting: 10 }, 'A500')).toEqual({ line: 'Copying 3 of 12 from A500…', finished: false });
    expect(fetchStatus({ total: 12, done: 11, failed: [{ name: 'x.lha', reason: 'Object not found' }], waiting: 0 }, 'A500'))
      .toEqual({ line: 'Copied 11, 1 failed: x.lha: Object not found', finished: true });
    expect(fetchStatus({ total: 2, done: 2, failed: [], waiting: 0 }, 'A500')).toEqual({ line: 'Copied 2', finished: true });
  });

  it('the count never passes the total; more than one failure names the first', () => {
    expect(fetchStatus({ total: 3, done: 2, failed: [{ name: 'a', reason: 'r' }], waiting: 0 }, 'A500').finished).toBe(true);
    expect(fetchStatus({ total: 3, done: 1, failed: [{ name: 'a', reason: 'r' }], waiting: 1 }, 'A500').line).toBe('Copying 3 of 3 from A500…');
    expect(fetchStatus({ total: 3, done: 1, failed: [{ name: 'a', reason: 'r' }, { name: 'b', reason: 's' }], waiting: 1 }, 'A500').line)
      .toBe('Copying 3 of 3 from A500…');
    expect(fetchStatus({ total: 3, done: 1, failed: [{ name: 'a', reason: 'r' }, { name: 'b', reason: 's' }], waiting: 0 }, 'A500'))
      .toEqual({ line: 'Copied 1, 2 failed: a: r; …', finished: true });
  });
});

describe('asksBeforeCopy and pickGone (Task 8 fix round 1: the source drawer is asked before every copy out of a volume)', () => {
  const from = 'NET:/b1/Work/Games';
  it('asks the picked drawers fresh (from memory on a resend), then the source drawer from memory LAST (fix round 2)', () => {
    expect(asksBeforeCopy(from, [], false)).toEqual([{ path: from, fresh: false }]);
    expect(asksBeforeCopy(from, [`${from}/A`, `${from}/B`], false))
      .toEqual([{ path: `${from}/A`, fresh: true }, { path: `${from}/B`, fresh: true }, { path: from, fresh: false }]);
    expect(asksBeforeCopy(from, [`${from}/A`], true)).toEqual([{ path: `${from}/A`, fresh: false }, { path: from, fresh: false }]);
  });

  it('a pick no longer in the re-listed source is "Object not found", named', () => {
    const entries = [{ path: `${from}/x.lha` }, { path: `${from}/A` }];
    expect(pickGone(entries, [`${from}/x.lha`, `${from}/A`])).toBeNull();
    expect(pickGone(entries, [`${from}/X.LHA`])).toBeNull();   // AmigaDOS names ignore case
    expect(pickGone(entries, [`${from}/x.lha`, `${from}/gone.txt`])).toBe('gone.txt: Object not found');
  });
});

// NET: volumes phase 2 (spec 2026-10-31 §2.3, §4.1): the status row of a job that changes the Amiga's disks.
describe('jobStatus', () => {
  type W = Parameters<typeof jobStatus>[0]['writes'][number];
  const w = (o: Partial<W>): W => ({ kind: 'delete', label: 'Work:old', to: null, status: 'done', removed: 0, reason: null, entry: null, quiet: false, ...o });
  const p = (o: Partial<Parameters<typeof jobStatus>[0]> = {}): Parameters<typeof jobStatus>[0] =>
    ({ total: 0, done: 0, failed: [], waiting: 0, skipped: 0, writes: [], direction: 'to', ...o });
  it('says what runs, with a delete counting up', () => {
    expect(jobStatus(p({ writes: [w({ status: 'waiting' })] }), 'A500')).toEqual({ line: 'Deleting Work:old on A500…', finished: false });
    expect(jobStatus(p({ writes: [w({ status: 'running', removed: 37 })] }), 'A500')).toEqual({ line: 'Deleting Work:old on A500… removed 37 so far', finished: false });
    expect(jobStatus(p({ writes: [w({ kind: 'mkdir', label: 'Work:New', status: 'running' })] }), 'A500').line).toBe('Making Work:New on A500…');
    expect(jobStatus(p({ total: 12, done: 2, waiting: 10 }), 'A500')).toEqual({ line: 'Copying 3 of 12 to A500…', finished: false });
    // A Makedir a copy needs is quiet while it runs: the copy is what is said.
    expect(jobStatus(p({ total: 2, waiting: 2, writes: [w({ kind: 'mkdir', status: 'running', quiet: true })] }), 'A500').line).toBe('Copying 1 of 2 to A500…');
  });
  // Spec 2026-10-31 §9: a move's removal that kept a drawer is said, not counted as deleted, not a failure.
  it('says what a move kept', () => {
    expect(jobStatus(p({ total: 2, done: 2, direction: 'from', writes: [w({ label: 'Work:Pair/a', removed: 1 }), w({ label: 'Work:Pair', kept: true })] }), 'A500'))
      .toEqual({ line: 'Copied 2 · Deleted Work:Pair/a · Kept Work:Pair: something new is in it', finished: true });
  });
  it('ends with what was done, and why anything was not', () => {
    expect(jobStatus(p({ writes: [w({ removed: 137 })] }), 'A500')).toEqual({ line: 'Deleted Work:old (137)', finished: true });
    expect(jobStatus(p({ writes: [w({ removed: 1 }), w({ label: 'Work:old.info', removed: 1, quiet: true })] }), 'A500').line).toBe('Deleted Work:old');
    expect(jobStatus(p({ writes: [w({ kind: 'mkdir', label: 'Work:New' })] }), 'A500').line).toBe('Made Work:New');
    expect(jobStatus(p({ writes: [w({ kind: 'rename', label: 'Work:a', to: 'Work:b' })] }), 'A500').line).toBe('Renamed Work:a to Work:b');
    expect(jobStatus(p({ writes: [w({ kind: 'protect', label: 'Work:x' })] }), 'A500').line).toBe('Protected Work:x');
    expect(jobStatus(p({ writes: [w({ kind: 'note', label: 'Work:x' })] }), 'A500').line).toBe('Comment on Work:x');
    expect(jobStatus(p({ writes: [w({ status: 'failed', removed: 37, entry: 'Libs/foo.library', reason: 'In use on the Amiga' })] }), 'A500'))
      .toEqual({ line: 'Removed 37, then stopped at Libs/foo.library: In use on the Amiga', finished: true });
    // Transfer 2.5: DEL 0 when a drawer delete stops before removing anything.
    expect(jobStatus(p({ writes: [w({ status: 'failed', removed: 0, entry: 'Libs/foo.library', reason: 'In use on the Amiga' })] }), 'A500').line)
      .toBe('Work:old: stopped at Libs/foo.library: In use on the Amiga');
    expect(jobStatus(p({ writes: [w({ kind: 'mkdir', label: 'Work:New', status: 'failed', reason: 'Already exists' })] }), 'A500').line)
      .toBe('Work:New: Already exists');
    expect(jobStatus(p({ total: 3, done: 2, skipped: 1 }), 'A500').line).toBe('Copied 2 to A500, skipped 1 (already there)');
    expect(jobStatus(p({ total: 2, done: 1, failed: [{ name: 'x.lha', reason: 'The disk is full' }] }), 'A500').line)
      .toBe('Copied 1 to A500, 1 failed: x.lha: The disk is full');
    // A copy out of a volume reads as before; a move out of one adds its delete.
    expect(jobStatus(p({ total: 2, done: 2, direction: 'from' }), 'A500').line).toBe('Copied 2');
    expect(jobStatus(p({ total: 1, done: 1, direction: 'from', writes: [w({ label: 'Work:x', removed: 1 })] }), 'A500').line).toBe('Copied 1 · Deleted Work:x');
    expect(jobStatus(p({ writes: [w({ label: 'Work:a' }), w({ label: 'Work:b' }), w({ label: 'Work:c' })] }), 'A500').line).toBe('Deleted 3 items');
  });
});
