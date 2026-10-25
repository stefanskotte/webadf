import { describe, it, expect } from 'vitest';
import {
  anyMoving, beginChange, endChange, idleClock, isSignedOutAnswer, mergeStaging, readIsCurrent, stagingView, trackStalls,
  upsertLibRows,
  type ChangeClock, type LibRow, type ServerRow, type UpRow,
} from '@/lib/upload-staging';
import { STALL_MS } from '@/lib/from-amiga-ui';

const send = (o: Partial<ServerRow>): ServerRow => ({ source: 'server', key: 'send:t1', kind: 'out', id: 't1',
  name: 'transfer-test.bin', sizeBytes: 200_704, board: { id: 'd1', name: 'WifiFloppy1' }, status: 'queued',
  doneBytes: 0, pct: null, savedAs: null, error: null, isDiskImage: false, title: null, at: 1000, ...o });
const amiga = (o: Partial<ServerRow>): ServerRow => send({ key: 'amiga:u1', kind: 'in', id: 'u1', name: 'DH0:x.adf',
  status: 'stored', ...o });
const lib = (o: Partial<LibRow>): LibRow => ({ source: 'lib', key: 'lib:1', kind: 'lib', name: 'a.adf', sizeBytes: 901_120,
  state: 'hashing', title: null, at: 500, ...o });
const up = (o: Partial<UpRow>): UpRow => ({ source: 'up', key: 'up:1', kind: 'out', name: 'f.bin', sizeBytes: 1024,
  state: 'uploading', boardName: 'WifiFloppy1', at: 600, ...o });
const one = (r: Parameters<typeof stagingView>[0][number], stalled: string[] = []) =>
  stagingView([r], 'all', new Set(stalled)).shown[0];

describe('sends', () => {
  it.each([
    [{ status: 'queued' }, 'Waiting for the Amiga', 'wait', ['cancel']],
    [{ status: 'sending', pct: 40 }, 'Sending · 40 %', 'busy', ['cancel']],
    [{ status: 'failed', error: 'Timed out' }, 'Failed · Timed out', 'fail', ['retry', 'clear']],
    [{ status: 'expired' }, 'Expired', 'fail', ['retry', 'clear']],
    [{ status: 'cancelled' }, 'Cancelled', 'wait', ['clear']],
  ] as const)('%j', (o, status, tone, actions) => {
    expect(one(send(o as Partial<ServerRow>))).toMatchObject({ status, tone, actions, where: 'to WifiFloppy1' });
  });
  it('a delivered send says where it was saved and can be cleared', () => {
    expect(one(send({ status: 'delivered', savedAs: 'transfer-test.bin' }))).toMatchObject({
      status: 'Delivered', tone: 'done', where: 'to WifiFloppy1 · saved as transfer-test.bin', actions: ['clear'] });
  });
});

describe('from the Amiga', () => {
  it('arriving', () => {
    expect(one(amiga({ status: 'receiving', pct: 47 }))).toMatchObject({
      status: 'Arriving · 47 %', tone: 'busy', actions: ['stop'], where: 'from WifiFloppy1' });
  });
  it('a stalled arriving file says where it stopped', () => {
    expect(one(amiga({ status: 'receiving', pct: 47 }), ['amiga:u1'])).toMatchObject({
      status: 'Stopped at 47 %', tone: 'busy', actions: ['stop'] });
  });
  it('a stalled arriving file says how to continue, as a row note', () => {
    expect(one(amiga({ status: 'receiving', pct: 47 }), ['amiga:u1']).note).toBe('send it again from the Amiga to continue');
    expect(one(amiga({ status: 'receiving', pct: 47 })).note).toBeNull();
  });
  it('failed', () => {
    expect(one(amiga({ status: 'failed', error: 'Too slow' }))).toMatchObject({
      status: 'Failed · Too slow', tone: 'fail', actions: ['clear'] });
  });
  it('stored disk image to add', () => {
    expect(one(amiga({ isDiskImage: true }))).toMatchObject({
      status: 'Stored · a disk image', tone: 'done', actions: ['add', 'download', 'send', 'delete'], gameId: null });
  });
  it('stored disk image already in the library opens its title', () => {
    expect(one(amiga({ isDiskImage: true, title: { gameId: 'g1', title: 'Turrican II' } }))).toMatchObject({
      status: 'Stored · a disk image', actions: ['open', 'download', 'send', 'delete'], gameId: 'g1' });
  });
  it('stored plain file', () => {
    expect(one(amiga({}))).toMatchObject({ status: 'Stored', actions: ['download', 'send', 'delete'] });
  });
});

describe('library and send uploads', () => {
  it.each([
    [{ state: 'hashing' }, 'Checking…', 'busy', []],
    [{ state: 'uploading' }, 'Uploading…', 'busy', []],
    [{ state: 'deduped' }, 'Already in the library', 'done', []],
    [{ state: 'done' }, 'Added', 'done', []],
    [{ state: 'failed', note: 'No disk images inside' }, 'Failed · No disk images inside', 'fail', ['clear']],
    [{ state: 'failed' }, 'Failed', 'fail', ['clear']],
  ] as const)('%j', (o, status, tone, actions) => {
    expect(one(lib(o as Partial<LibRow>))).toMatchObject({ status, tone, actions, where: 'into the library' });
  });
  it('a titled library row names it and opens it', () => {
    const t = { gameId: 'g1', title: 'Turrican II' };
    expect(one(lib({ state: 'done', title: t, note: 'from X.dms' }))).toMatchObject({
      where: 'into the library · Turrican II', actions: ['open'], gameId: 'g1', note: 'from X.dms' });
    expect(one(lib({ state: 'deduped', title: t }))).toMatchObject({ actions: ['open'] });
  });
  it('size uses formatSize', () => {
    expect(one(lib({ sizeBytes: 901_120 })).size).toBe('880 KB');
  });
  it('send uploads', () => {
    expect(one(up({}))).toMatchObject({ status: 'Uploading…', tone: 'busy', actions: [], where: 'to WifiFloppy1' });
    expect(one(up({ state: 'failed', note: 'Network' }))).toMatchObject({
      status: 'Failed · Network', tone: 'fail', actions: ['clear'] });
  });
});

describe('view', () => {
  const rows = [
    send({ key: 'send:a', status: 'delivered' }), amiga({ key: 'amiga:b' }), amiga({ key: 'amiga:c', status: 'failed' }),
    lib({ key: 'lib:d', state: 'failed' }), lib({ key: 'lib:e' }), up({ key: 'up:f', state: 'failed' }),
  ];
  it('counts over all rows; send uploads count as out', () => {
    const v = stagingView(rows, 'lib', new Set());
    expect(v.counts).toEqual({ all: 6, in: 2, out: 2, lib: 2 });
    expect(v.shown.map((x) => x.key)).toEqual(['lib:d', 'lib:e']);
    expect(v.clearLocal).toEqual(['lib:d']);
    expect(v.clearServer).toEqual([]);
  });
  it('clear keys split by origin and never hold a stored file', () => {
    const v = stagingView(rows, 'all', new Set());
    expect(v.clearServer).toEqual(['send:a', 'amiga:c']);
    expect(v.clearLocal).toEqual(['lib:d', 'up:f']);
  });
  it('the out filter holds sends and send uploads', () => {
    expect(stagingView(rows, 'out', new Set()).shown.map((x) => x.key)).toEqual(['send:a', 'up:f']);
  });
});

describe('merge and upsert', () => {
  it('sorts by time desc then key', () => {
    const m = mergeStaging([send({ key: 'send:b', at: 5 }), send({ key: 'send:a', at: 5 })], [lib({ at: 9 }), up({ at: 1 })]);
    expect(m.map((r) => r.key)).toEqual(['lib:1', 'send:a', 'send:b', 'up:1']);
  });
  it('upsert replaces in place and appends new', () => {
    const out = upsertLibRows([lib({ key: 'lib:1' }), lib({ key: 'lib:2' })],
      [lib({ key: 'lib:1', state: 'done' }), lib({ key: 'lib:3' })]);
    expect(out.map((r) => [r.key, r.state])).toEqual([['lib:1', 'done'], ['lib:2', 'hashing'], ['lib:3', 'hashing']]);
  });
});

describe('anyMoving and trackStalls', () => {
  it('moving states', () => {
    expect(anyMoving([send({ status: 'queued' })], new Set())).toBe(true);
    expect(anyMoving([send({ status: 'sending' })], new Set())).toBe(true);
    expect(anyMoving([amiga({ status: 'receiving' })], new Set())).toBe(true);
    expect(anyMoving([amiga({ status: 'receiving' })], new Set(['amiga:u1']))).toBe(false);
    expect(anyMoving([lib({ state: 'hashing' })], new Set())).toBe(true);
    expect(anyMoving([up({})], new Set())).toBe(true);
    expect(anyMoving([send({ status: 'delivered' }), amiga({}), lib({ state: 'done' })], new Set())).toBe(false);
  });
  it('stalls after STALL_MS at the same bytes, restarts when bytes move', () => {
    const r = amiga({ status: 'receiving', doneBytes: 100 });
    const a = trackStalls({}, [r], 1000);
    expect(a.stalled.size).toBe(0);
    const b = trackStalls(a.seen, [r], 1000 + STALL_MS);
    expect([...b.stalled]).toEqual(['amiga:u1']);
    const c = trackStalls(b.seen, [{ ...r, doneBytes: 200 }], 2000 + STALL_MS);
    expect(c.stalled.size).toBe(0);
    expect(c.seen['amiga:u1']).toEqual({ bytes: 200, since: 2000 + STALL_MS });
    expect(trackStalls(c.seen, [amiga({ status: 'stored' })], 9e9).seen).toEqual({});
  });
});

describe('readIsCurrent: a list read is painted only if no change of ours overlapped it', () => {
  const at = (c: ChangeClock): ChangeClock => ({ ...c });
  it('paints a read with no change anywhere near it', () => {
    let c = idleClock();
    c = endChange(beginChange(c));          // an earlier change, finished before the read
    const start = at(c);
    expect(readIsCurrent(start, at(c))).toBe(true);
  });
  it('discards a read that starts and ends inside a change (the Clear POST case)', () => {
    const c = beginChange(idleClock());
    const start = at(c);
    expect(readIsCurrent(start, at(c))).toBe(false);
  });
  it('discards a read straddling the start of a change', () => {
    const start = idleClock();
    const end = beginChange(start);
    expect(readIsCurrent(start, end)).toBe(false);
  });
  it('discards a read straddling the end of a change', () => {
    const c = beginChange(idleClock());
    const start = at(c);
    expect(readIsCurrent(start, endChange(c))).toBe(false);
  });
  it('discards a read that a whole change happened inside', () => {
    const start = idleClock();
    expect(readIsCurrent(start, endChange(beginChange(start)))).toBe(false);
  });
  it('two overlapping changes: still discarded until both end', () => {
    const two = beginChange(beginChange(idleClock()));
    const one = endChange(two);
    expect(readIsCurrent(at(one), at(one))).toBe(false);
    const none = endChange(one);
    expect(readIsCurrent(at(none), at(none))).toBe(true);
  });
});

describe('isSignedOutAnswer', () => {
  const res = (o: { redirected?: boolean; type?: string | null; status?: number }) =>
    ({ redirected: o.redirected ?? false, status: o.status ?? 200, ok: (o.status ?? 200) < 300,
       headers: new Headers(o.type === null ? {} : { 'content-type': o.type ?? 'application/json' }) }) as Response;
  it('a JSON answer is not signed out', () => {
    expect(isSignedOutAnswer(res({}))).toBe(false);
    expect(isSignedOutAnswer(res({ type: 'application/json; charset=utf-8', status: 409 }))).toBe(false);
  });
  it('a redirected answer is signed out, whatever its type', () => {
    expect(isSignedOutAnswer(res({ redirected: true }))).toBe(true);
    expect(isSignedOutAnswer(res({ redirected: true, type: 'text/html' }))).toBe(true);
  });
  it('a 200 HTML page (the sign-in page) is signed out', () => {
    expect(isSignedOutAnswer(res({ type: 'text/html; charset=utf-8' }))).toBe(true);
  });
  it('an HTML error page (a 500, a 404) stays an ordinary failure', () => {
    expect(isSignedOutAnswer(res({ type: 'text/html', status: 500 }))).toBe(false);
    expect(isSignedOutAnswer(res({ type: 'text/html', status: 404 }))).toBe(false);
  });
  it('a 204 with no body is not signed out unless redirected', () => {
    expect(isSignedOutAnswer(res({ status: 204, type: null }))).toBe(false);
    expect(isSignedOutAnswer(res({ status: 204, type: null, redirected: true }))).toBe(true);
  });
});

describe('pct (C3 spec §3)', () => {
  it('is the server percent while sending or receiving, else null', () => {
    expect(one(send({ status: 'sending', pct: 40 })).pct).toBe(40);
    expect(one(amiga({ status: 'receiving', pct: 81 })).pct).toBe(81);
    expect(one(send({ status: 'delivered', pct: null })).pct).toBeNull();
    expect(one(amiga({ status: 'stored', pct: 99 })).pct).toBeNull();
    expect(one(lib({ state: 'uploading' })).pct).toBeNull();
    expect(one(up({ state: 'uploading' })).pct).toBeNull();
  });
});
