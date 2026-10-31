import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_remote_requests_test';
const url = new URL(base);
url.pathname = `/${DB}`;
process.env.DATABASE_URL = url.toString();

async function admin(stmt: string) {
  const c = new Client({ connectionString: base });
  await c.connect();
  try { await c.query(stmt); } finally { await c.end(); }
}

const { getDb, closeDb } = await import('@/db');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');

const { and, eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const rr = await import('./remote-requests');
const { requestListing, latestFor, takeWaiting, answerPiece, addGets, getForUpload, settleGet, expireStale, touchGet, copyMoving, addWrites, pendingAlive } = rr;
const { requestLine } = await import('./remote-wire');

const deviceId = 'rb1';
const orgId = 'ro1';
const t0 = new Date('2026-10-30T12:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);
const reqVersionOf = async (id: string) => (await getDb().select({ v: devices.reqVersion }).from(devices).where(eq(devices.id, id)))[0].v;
const rowOf = async (id: string) => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.id, id)))[0];
const ridOf = (s: { state: string; row?: { id: string } }) => s.row!.id;

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  const db = getDb();
  await db.insert(organization).values([{ id: orgId, name: 'ro1', slug: 'ro1', createdAt: new Date() }, { id: 'ro2', name: 'ro2', slug: 'ro2', createdAt: new Date() }]);
  await db.insert(devices).values([
    { id: deviceId, orgId, name: 'A500', tokenHash: 'rh1' },
    { id: 'rb2', orgId: 'ro2', name: 'Other', tokenHash: 'rh2' },
  ]);
});
afterAll(async () => {
  await closeDb();
  await admin(`drop database if exists ${DB} with (force)`);
});

// Each case starts from an empty queue and version 0 for rb1.
beforeEach(async () => {
  await getDb().delete(remoteRequests);
  await getDb().update(devices).set({ reqVersion: 0 });
});

// NET: volumes (spec 2026-10-30 §4.1): the request queue's table and the device columns it rests on.
describe('remote_requests schema', () => {
  it('has the table and the device columns', async () => {
    const db = getDb();
    const t = await db.execute(sql`select to_regclass('public.remote_requests') as t`);
    expect(t.rows[0].t).toBe('remote_requests');
    const c = await db.execute(sql`select column_name from information_schema.columns where table_name = 'devices'
      and column_name in ('req_version','rx_proto','browse_on') order by column_name`);
    expect(c.rows.map((r) => r.column_name)).toEqual(['browse_on', 'req_version', 'rx_proto']);
  });
  it('has the writes columns (phase 2): transfers.amiga_dest, on_clash, job_id, move_source; devices.write_on', async () => {
    const c = await getDb().execute(sql`select table_name || '.' || column_name as c from information_schema.columns
      where (table_name = 'transfers' and column_name in ('amiga_dest','on_clash','job_id','move_source'))
         or (table_name = 'devices' and column_name = 'write_on') order by 1`);
    expect(c.rows.map((r) => r.c)).toEqual(['devices.write_on', 'transfers.amiga_dest', 'transfers.job_id', 'transfers.move_source', 'transfers.on_clash']);
  });
  it('indexes upload_id: every chunk of every upload looks its get up by it', async () => {
    const i = await getDb().execute(sql`select indexdef from pg_indexes where tablename = 'remote_requests' and indexname = 'remote_requests_upload_idx'`);
    expect(i.rows.map((r) => r.indexdef)).toEqual([expect.stringContaining('(upload_id)')]);
  });
});

// NET: volumes (spec §4.2-4.4): listing reuse, the 2-minute memory, answers in pieces, timeouts.
describe('the request store', () => {
  it('a listing request is made once and shared while it waits', async () => {
    const a = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Programs', fresh: false }, t0);
    const b = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'work:programs', fresh: false }, t0);
    expect(a.state).toBe('pending'); expect(b.state).toBe('pending');
    expect(b.state === 'pending' && a.state === 'pending' && b.row.id === a.row.id).toBe(true);
    expect(await reqVersionOf(deviceId)).toBe(1);
  });

  it('requests made at the same moment share one row', async () => {
    const asks = await Promise.all(Array.from({ length: 6 }, () =>
      requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Race', fresh: false }, t0)));
    expect(new Set(asks.map((x) => ridOf(x as { state: string; row?: { id: string } }))).size).toBe(1);
    expect(asks.every((x) => x.state === 'pending')).toBe(true);
    expect(await reqVersionOf(deviceId)).toBe(1);
  });

  it('the board takes waiting requests as sent, at most 8', async () => {
    for (let i = 0; i < 9; i++) await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: `Work:d${i}`, fresh: false }, at(i));
    const first = await takeWaiting(getDb(), deviceId, at(20));
    expect(first).toHaveLength(8);
    expect(first.every((r) => r.status === 'sent')).toBe(true);
    expect(first[0].amigaPath).toBe('Work:d0');
    expect((await rowOf(first[0].id)).sentAt).toEqual(at(20));
    expect(await takeWaiting(getDb(), deviceId, at(21))).toHaveLength(1);
  });

  // Final review: addGets wakes the board once, and a take hands out at most 8 -- the board must be woken again while
  // any wait, and a listing asked meanwhile must not starve behind the copy's gets.
  it('20 gets: a take hands out 8 and wakes the board again; the last take wakes nobody', async () => {
    const tg = { dest: 'STASH:', rel: ['x'], replace: false, library: null };
    await addGets(getDb(), { orgId, deviceId, fetchId: 'f20', files: Array.from({ length: 20 }, (_, i) => ({ amigaPath: `Work:g${i}`, target: tg })) }, t0);
    const v1 = await reqVersionOf(deviceId);
    expect(await takeWaiting(getDb(), deviceId, at(1))).toHaveLength(8);
    expect(await reqVersionOf(deviceId)).toBe(v1 + 1);
    expect(await takeWaiting(getDb(), deviceId, at(2))).toHaveLength(8);
    expect(await reqVersionOf(deviceId)).toBe(v1 + 2);
    expect(await takeWaiting(getDb(), deviceId, at(3))).toHaveLength(4);
    expect(await reqVersionOf(deviceId)).toBe(v1 + 2);
    expect(await takeWaiting(getDb(), deviceId, at(4))).toEqual([]);
    expect(await reqVersionOf(deviceId)).toBe(v1 + 2);
  });

  it('a listing asked behind 12 waiting gets is handed out in the next take, first', async () => {
    const tg = { dest: 'STASH:', rel: ['x'], replace: false, library: null };
    await addGets(getDb(), { orgId, deviceId, fetchId: 'f12', files: Array.from({ length: 12 }, (_, i) => ({ amigaPath: `Work:g${i}`, target: tg })) }, t0);
    const d = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Later', fresh: false }, at(1));
    const taken = await takeWaiting(getDb(), deviceId, at(2));
    expect(taken).toHaveLength(8);
    expect(taken[0].id).toBe(ridOf(d));
    expect(taken.slice(1).every((r) => r.kind === 'get')).toBe(true);
  });

  it('an answer in two pieces becomes a ready listing; a repeat piece changes nothing; a gap is 409', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:', fresh: false }, t0);
    const rid = ridOf(p);
    await takeWaiting(getDb(), deviceId, t0);
    const ent = (n: string, k: string) => `ENT ${rid} ${k} 10 0 1.0.0 1:${n} 0:`;
    expect(await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [ent('a', 'f')], last: false }, t0)).toEqual({ ok: true });
    expect(await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [ent('a', 'f')], last: false }, t0)).toEqual({ ok: true });
    expect(await answerPiece(getDb(), deviceId, rid, { piece: 2, lines: [], last: true }, t0)).toEqual({ ok: false, status: 409 });
    expect(await answerPiece(getDb(), deviceId, rid, { piece: 1, lines: [ent('b', 'd'), `DONE ${rid} 2`], last: true }, t0)).toEqual({ ok: true });
    const s = await latestFor(getDb(), deviceId, 'dir', 'Work:', at(1));
    expect(s.state).toBe('ready');
    expect(s.state === 'ready' && (s.row.answer as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('an ERR answer fails the request and is shown for 10 s, then a visit asks again', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:x', fresh: false }, t0);
    const rid = ridOf(p);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [`ERR ${rid} notfound 16:object not found`], last: true }, t0);
    const s = await latestFor(getDb(), deviceId, 'dir', 'Work:x', at(5));
    expect(s.state).toBe('failed');
    expect(s.state === 'failed' && s.row.errorCode).toBe('notfound');
    expect((await latestFor(getDb(), deviceId, 'dir', 'Work:x', at(11))).state).toBe('none');
    const n = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:x', fresh: false }, at(11));
    expect(n.state).toBe('pending');
    expect(n.state === 'pending' && n.row.id).not.toBe(rid);
  });

  it('a remembered listing is ready for 2 minutes, then a visit asks again; fresh always asks', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'vols', amigaPath: '', fresh: false }, t0);
    const rid = ridOf(p);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [`VOL ${rid} 4:Work 4:DH0: 100 50 1.0.0`, `DONE ${rid} 1`], last: true }, t0);
    const r = await requestListing(getDb(), { orgId, deviceId, kind: 'vols', amigaPath: '', fresh: false }, at(119));
    expect(r.state).toBe('ready');
    expect(r.state === 'ready' && r.ageMs).toBe(119_000);
    const old = await requestListing(getDb(), { orgId, deviceId, kind: 'vols', amigaPath: '', fresh: false }, at(121));
    expect(old.state).toBe('pending');
    // a new pending request exists; finish it too, then a fresh visit still asks
    const rid2 = ridOf(old);
    await takeWaiting(getDb(), deviceId, at(121));
    await answerPiece(getDb(), deviceId, rid2, { piece: 0, lines: [`DONE ${rid2} 0`], last: true }, at(121));
    const f = await requestListing(getDb(), { orgId, deviceId, kind: 'vols', amigaPath: '', fresh: true }, at(131));
    expect(f.state).toBe('pending');
    expect(f.state === 'pending' && f.row.id).not.toBe(rid2);
  });

  // Final review: Refresh after the pane gave up (20 s) asks again rather than share the stuck request for up to 60 s.
  it('fresh fails a pending request older than the pane waits and asks again; a younger one is shared', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Stuck', fresh: false }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    const young = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Stuck', fresh: true }, at(19));
    expect(young.state === 'pending' && young.row.id).toBe(ridOf(p));
    const v = await reqVersionOf(deviceId);
    const again = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Stuck', fresh: true }, at(21));
    expect(again.state).toBe('pending');
    expect(again.state === 'pending' && again.row.id).not.toBe(ridOf(p));
    expect(await rowOf(ridOf(p))).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(await reqVersionOf(deviceId)).toBe(v + 1);
    // Without fresh, a pending request is still shared however old (until the 60 s timeout).
    const shared = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Stuck', fresh: false }, at(45));
    expect(shared.state === 'pending' && shared.row.id).toBe(ridOf(again));
  });

  it('a malformed line fails the request with bad', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:m', fresh: false }, t0);
    const rid = ridOf(p);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: ['ENT x'], last: false }, t0);
    const r = await rowOf(rid);
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('bad');
  });

  it("another board cannot answer or take this board's request", async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:o', fresh: false }, t0);
    const rid = ridOf(p);
    expect(await takeWaiting(getDb(), 'rb2', t0)).toEqual([]);
    await takeWaiting(getDb(), deviceId, t0);
    expect(await answerPiece(getDb(), 'rb2', rid, { piece: 0, lines: [`DONE ${rid} 0`], last: true }, t0)).toEqual({ ok: false, status: 404 });
    expect((await rowOf(rid)).status).toBe('sent');
  });

  it('stale requests time out', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:s', fresh: false }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    const s = await latestFor(getDb(), deviceId, 'dir', 'Work:s', at(61));
    expect(s.state).toBe('failed');
    expect(s.state === 'failed' && s.row.errorCode).toBe('timeout');
    expect(ridOf(p)).toBe(s.state === 'failed' ? s.row.id : '');
    const [g] = await addGets(getDb(), { orgId, deviceId, fetchId: 'f1', files: [{ amigaPath: 'Work:a', target: { dest: 'd', rel: [], replace: false, library: null } }] }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    await expireStale(getDb(), at(599));
    expect((await rowOf(g)).status).toBe('sent');
    await expireStale(getDb(), at(601));
    const r = await rowOf(g);
    expect(r.status).toBe('failed'); expect(r.errorCode).toBe('timeout'); expect(r.errorText).toBe('stopped answering');
  });

  // Fix round 1 ruling: a get times out after 10 minutes with no get activity -- its own once fetching, the board's
  // (any of its gets) while it is still only sent, queued behind siblings Transfer works through one at a time.
  it('a sent get whose sibling showed life recently does not time out; the board silent for 10 minutes does', async () => {
    const t = { dest: 'STASH:', rel: ['a'], replace: false, library: null };
    const [g1, g2] = await addGets(getDb(), { orgId, deviceId, fetchId: 'fa', files: [{ amigaPath: 'Work:a', target: t }, { amigaPath: 'Work:b', target: t }] }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, g1, { piece: 0, lines: [`GOT ${g1} 1`], last: true }, at(590));
    await expireStale(getDb(), at(601));
    expect((await rowOf(g1)).status).toBe('fetching');
    expect((await rowOf(g2)).status).toBe('sent');
    await expireStale(getDb(), at(1191));
    expect((await rowOf(g1))).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect((await rowOf(g2))).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  // A500 bench 2026-10-31: Transfer answers nothing while a get's file moves, and the board fetches nothing meanwhile, so
  // a listing asked for during a long copy waits for it -- and times out 60 s after the copy last moved, not after the ask.
  it('a waiting listing behind a moving copy waits for it, and times out 60 s after the copy last moved', async () => {
    const t = { dest: 'STASH:', rel: ['a.adf'], replace: false, library: null };
    const [g] = await addGets(getDb(), { orgId, deviceId, fetchId: 'fc', files: [{ amigaPath: 'Work:a.adf', target: t }] }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, g, { piece: 0, lines: [`GOT ${g} 1`], last: true }, at(1));
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:d', fresh: false }, at(2));
    expect(await copyMoving(getDb(), deviceId, at(2))).toBe('Work:a.adf');
    await touchGet(getDb(), { id: g }, at(50));
    await touchGet(getDb(), { id: g }, at(100));
    await expireStale(getDb(), at(150));
    expect((await rowOf(ridOf(p))).status).toBe('waiting');
    await settleGet(getDb(), g, { ok: true }, at(130));
    expect(await copyMoving(getDb(), deviceId, at(131))).toBeNull();
    await expireStale(getDb(), at(189));
    expect((await rowOf(ridOf(p))).status).toBe('waiting');
    await expireStale(getDb(), at(191));
    expect(await rowOf(ridOf(p))).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  // A500 bench 2026-10-31: a 1000-entry drawer arrives in three pieces over ~36 s, and RAM: lists at ~15 entries a
  // second: a listing's 60 s run from its last piece, not from when the board took it.
  it('a listing whose pieces keep arriving does not time out; 60 s after its last piece it does', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:big', fresh: false }, t0);
    const rid = ridOf(p);
    await takeWaiting(getDb(), deviceId, t0);
    const ents = (n: number) => Array.from({ length: n }, (_, i) => `ENT ${rid} d 0 0 9100.0.0 5:d${String(i).padStart(4, '0')} 0:`);
    await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: ents(400), last: false }, at(40));
    await answerPiece(getDb(), deviceId, rid, { piece: 1, lines: ents(400), last: false }, at(80));
    await expireStale(getDb(), at(139));
    expect((await rowOf(rid)).status).toBe('sent');
    await expireStale(getDb(), at(141));
    expect(await rowOf(rid)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  it('Refresh shares a listing whose pieces are arriving, however old; one silent 20 s is asked again', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:big2', fresh: false }, t0);
    const rid = ridOf(p);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, rid, { piece: 0, lines: [`ENT ${rid} d 0 0 9100.0.0 1:a 0:`], last: false }, at(30));
    const shared = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:big2', fresh: true }, at(45));
    expect(shared.state === 'pending' && shared.row.id).toBe(rid);
    const again = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:big2', fresh: true }, at(51));
    expect(again.state === 'pending' && again.row.id).not.toBe(rid);
  });

  // Review of the bench fix: the board fetches whenever no file is moving -- right after GOT too -- and then holds the
  // listing while Transfer's PUT moves the file. 'sent' with nothing answered waits for the copy the same way.
  it('a listing the board took but holds behind a moving copy waits for it too', async () => {
    const t = { dest: 'STASH:', rel: ['a.adf'], replace: false, library: null };
    const [g] = await addGets(getDb(), { orgId, deviceId, fetchId: 'fe', files: [{ amigaPath: 'Work:a.adf', target: t }] }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, g, { piece: 0, lines: [`GOT ${g} 1`], last: true }, at(1));
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:held', fresh: false }, at(2));
    await takeWaiting(getDb(), deviceId, at(3));
    expect((await rowOf(ridOf(p))).status).toBe('sent');
    await touchGet(getDb(), { id: g }, at(60));
    await touchGet(getDb(), { id: g }, at(110));
    await expireStale(getDb(), at(150));
    expect((await rowOf(ridOf(p))).status).toBe('sent');
    await expireStale(getDb(), at(171));
    expect(await rowOf(ridOf(p))).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  it('a copy that stopped moving holds no listing back', async () => {
    const t = { dest: 'STASH:', rel: ['a.adf'], replace: false, library: null };
    const [g] = await addGets(getDb(), { orgId, deviceId, fetchId: 'fd', files: [{ amigaPath: 'Work:a.adf', target: t }] }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    await answerPiece(getDb(), deviceId, g, { piece: 0, lines: [`GOT ${g} 1`], last: true }, at(1));
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:d', fresh: false }, at(2));
    expect(await copyMoving(getDb(), deviceId, at(62))).toBeNull();
    await expireStale(getDb(), at(63));
    expect(await rowOf(ridOf(p))).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  it('a get that failed timeout is still found for its late upload', async () => {
    const [g] = await addGets(getDb(), { orgId, deviceId, fetchId: 'fb', files: [{ amigaPath: 'Work:a', target: { dest: 'STASH:', rel: ['a'], replace: false, library: null } }] }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    await expireStale(getDb(), at(601));
    expect((await getForUpload(getDb(), deviceId, g))?.id).toBe(g);
  });

  it('a waiting request nobody fetched also times out', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:w', fresh: false }, t0);
    await expireStale(getDb(), at(61));
    expect((await rowOf(ridOf(p))).errorCode).toBe('timeout');
  });

  it('rows older than a day are deleted when a request is added', async () => {
    await getDb().insert(remoteRequests).values({ id: 'oldrow', orgId, deviceId, kind: 'vols', status: 'done', createdAt: new Date(t0.getTime() - 25 * 3600_000), answeredAt: new Date(t0.getTime() - 25 * 3600_000) });
    await requestListing(getDb(), { orgId, deviceId, kind: 'vols', amigaPath: '', fresh: false }, t0);
    expect(await rowOf('oldrow')).toBeUndefined();
  });

  it('gets: rows inserted with one version bump; GOT makes fetching; settle ends it', async () => {
    const tg = { dest: 'd', rel: ['x'], replace: true, library: { collectionId: null } };
    const ids = await addGets(getDb(), { orgId, deviceId, fetchId: 'f2', files: [
      { amigaPath: 'Work:a', target: tg }, { amigaPath: 'Work:b', target: tg }] }, t0);
    expect(ids).toHaveLength(2);
    expect(await reqVersionOf(deviceId)).toBe(1);
    const taken = await takeWaiting(getDb(), deviceId, t0);
    expect(taken).toHaveLength(2);
    expect(taken[0].fetchId).toBe('f2');
    expect(await answerPiece(getDb(), deviceId, ids[0], { piece: 0, lines: [`GOT ${ids[0]} 1`], last: true }, t0)).toEqual({ ok: true });
    expect((await rowOf(ids[0])).status).toBe('fetching');
    expect((await getForUpload(getDb(), deviceId, ids[0]))?.id).toBe(ids[0]);
    expect((await getForUpload(getDb(), 'rb2', ids[0]))).toBeNull();
    await settleGet(getDb(), ids[0], { ok: true }, at(1));
    expect((await rowOf(ids[0])).status).toBe('done');
    await settleGet(getDb(), ids[1], { ok: false, code: 'io', text: 'broke' }, at(1));
    const f = await rowOf(ids[1]);
    expect(f.status).toBe('failed'); expect(f.errorCode).toBe('io'); expect(f.errorText).toBe('broke');
    expect(await getForUpload(getDb(), deviceId, ids[1])).toBeNull();
  });
});

// NET: volumes phase 2 (spec 2026-10-31 §2.3, §4.1; plan W9-W13): the one-line writes.
describe('write requests', () => {
  const canWrite = (on: boolean) => getDb().update(devices).set({ rxProto: on ? 4 : 3, browseOn: true, writeOn: on }).where(eq(devices.id, deviceId));
  const answer = (rid: string, lines: string[], piece: number, last: boolean, when: Date) => answerPiece(getDb(), deviceId, rid, { piece, lines, last }, when);
  const remember = async (path: string, when: Date) => {
    const s = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: path, fresh: true }, when);
    await takeWaiting(getDb(), deviceId, when);
    await answer(ridOf(s as { state: string; row?: { id: string } }), [`DONE ${ridOf(s as { state: string; row?: { id: string } })} 0`], 0, true, when);
  };
  beforeEach(() => canWrite(true));

  it('a job\'s writes go in the order made, 1 ms apart, after listings and before gets, with their arguments on the line', async () => {
    const tg = { dest: 'STASH:', rel: ['x'], replace: false, library: null };
    await addGets(getDb(), { orgId, deviceId, fetchId: 'fg', files: [{ amigaPath: 'Work:g', target: tg }] }, t0);
    const ids = await addWrites(getDb(), { orgId, deviceId, jobId: 'j1', writes: [
      { kind: 'rename', amigaPath: 'Work:a', args: { to: 'Work:b' }, label: 'Work:a' },
      { kind: 'rename', amigaPath: 'Work:a.info', args: { to: 'Work:b.info' }, icon: true, label: 'Work:a.info' },
    ] }, at(1));
    await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:', fresh: false }, at(2));
    expect(await reqVersionOf(deviceId)).toBe(3);
    const rows = await Promise.all(ids.map(rowOf));
    expect(rows.map((r) => [r.kind, r.fetchId, r.createdAt.getTime() - at(1).getTime(), r.target])).toEqual([
      ['rename', 'j1', 0, { to: 'Work:b', label: 'Work:a' }],
      ['rename', 'j1', 1, { to: 'Work:b.info', label: 'Work:a.info', icon: true }],
    ]);
    const taken = await takeWaiting(getDb(), deviceId, at(3));
    expect(taken.map((r) => requestLine(r))).toEqual([
      'RENAME ' + ids[0] + ' 6:Work:a 6:Work:b\n', 'RENAME ' + ids[1] + ' 11:Work:a.info 11:Work:b.info\n',
      expect.stringMatching(/^DIR /), expect.stringMatching(/^GET /),
    ]);
  });

  it('a board that cannot write is never handed a write: it fails readonly at the take, listings go on', async () => {
    await canWrite(false);
    const [w] = await addWrites(getDb(), { orgId, deviceId, jobId: 'j2', writes: [{ kind: 'mkdir', amigaPath: 'Work:New', label: 'Work:New' }] }, t0);
    await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:', fresh: false }, t0);
    const taken = await takeWaiting(getDb(), deviceId, at(1));
    expect(taken.map((r) => r.kind)).toEqual(['dir']);
    expect(await rowOf(w)).toMatchObject({ status: 'failed', errorCode: 'readonly', errorText: 'Writing is off in Transfer' });
  });

  it('a drawer delete: DEL pieces count up and keep it alive; DONE ends it and drops the memory of what it changed', async () => {
    await remember('Work:', t0);
    await remember('Work:old', t0);
    await remember('Work:old/sub', t0);
    const [d] = await addWrites(getDb(), { orgId, deviceId, jobId: 'j3', writes: [{ kind: 'delete', amigaPath: 'Work:old', label: 'Work:old' }] }, at(1));
    await takeWaiting(getDb(), deviceId, at(1));
    expect(await answer(d, [`DEL ${d} 50`], 0, false, at(40))).toEqual({ ok: true });
    expect(await answer(d, [`DEL ${d} 100`], 1, false, at(90))).toEqual({ ok: true });
    await expireStale(getDb(), at(140));   // 50 s after the last DEL: still alive
    expect(await rowOf(d)).toMatchObject({ status: 'sent', answer: { removed: 100 } });
    await remember('Work:other', at(140));
    for (const p of ['Work:', 'Work:old', 'Work:old/sub']) await remember(p, at(140));
    expect(await answer(d, [`DONE ${d} 137`], 2, true, at(141))).toEqual({ ok: true });
    expect(await rowOf(d)).toMatchObject({ status: 'done', answer: { removed: 137 } });
    for (const p of ['Work:', 'Work:old', 'Work:old/sub']) expect((await latestFor(getDb(), deviceId, 'dir', p, at(142))).state).toBe('none');
    expect((await latestFor(getDb(), deviceId, 'dir', 'Work:other', at(142))).state).toBe('ready');
  });

  it('a delete that stops half way keeps the count; a missing icon is no failure; a silent write times out', async () => {
    const [d, icon, quiet] = await addWrites(getDb(), { orgId, deviceId, jobId: 'j4', writes: [
      { kind: 'delete', amigaPath: 'Work:Libs', label: 'Work:Libs' },
      { kind: 'delete', amigaPath: 'Work:Libs.info', icon: true, label: 'Work:Libs.info' },
      { kind: 'mkdir', amigaPath: 'Work:New', label: 'Work:New' },
    ] }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    await answer(d, [`DEL ${d} 37`, `ERR ${d} busy 31:Libs/foo.library: object in use`], 0, true, at(5));
    expect(await rowOf(d)).toMatchObject({ status: 'failed', errorCode: 'busy', errorText: 'Libs/foo.library: object in use', answer: { removed: 37 } });
    await answer(icon, [`ERR ${icon} notfound 16:object not found`], 0, true, at(6));
    expect((await rowOf(icon)).status).toBe('done');
    await expireStale(getDb(), at(61));
    expect(await rowOf(quiet)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  it('a rename drops both drawers\' memory; MKDIR, PROTECT and NOTE their parent\'s', async () => {
    for (const p of ['Work:', 'Work:a', 'Work:b']) await remember(p, t0);
    const [r] = await addWrites(getDb(), { orgId, deviceId, jobId: 'j5', writes: [{ kind: 'rename', amigaPath: 'Work:a/x', args: { to: 'Work:b/x' }, label: 'Work:a/x' }] }, at(1));
    await takeWaiting(getDb(), deviceId, at(1));
    await answer(r, [`DONE ${r} 1`], 0, true, at(2));
    expect((await latestFor(getDb(), deviceId, 'dir', 'Work:a', at(3))).state).toBe('none');
    expect((await latestFor(getDb(), deviceId, 'dir', 'Work:b', at(3))).state).toBe('none');
    expect((await latestFor(getDb(), deviceId, 'dir', 'Work:', at(3))).state).toBe('ready');
    const [m] = await addWrites(getDb(), { orgId, deviceId, jobId: 'j6', writes: [{ kind: 'mkdir', amigaPath: 'Work:New', label: 'Work:New' }] }, at(4));
    await takeWaiting(getDb(), deviceId, at(4));
    await answer(m, [`DONE ${m} 1`], 0, true, at(5));
    expect((await latestFor(getDb(), deviceId, 'dir', 'Work:', at(6))).state).toBe('none');
  });

  it('a listing arriving in pieces is alive only while a piece came within 30 s (§4.4)', async () => {
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:Big', fresh: false }, t0);
    await takeWaiting(getDb(), deviceId, t0);
    const rid = ridOf(p as { state: string; row?: { id: string } });
    await answer(rid, [`ENT ${rid} f 1 0 1.0.0 1:a 0:`], 0, false, at(1));
    const row = await rowOf(rid);
    expect(pendingAlive(row, at(20))).toBe(true);
    expect(pendingAlive(row, at(32))).toBe(false);
    expect(pendingAlive({ ...row, pieces: 0 }, at(2))).toBe(false);
  });

  it('a listing waits behind a queue file the board is sending, or an Amiga upload it is receiving (§4.4)', async () => {
    const { transfers } = await import('@/db/schema/transfers');
    const { amigaUploads } = await import('@/db/schema/amiga-uploads');
    await getDb().delete(transfers);
    await getDb().update(devices).set({ sendRxAt: at(0) }).where(eq(devices.id, deviceId));
    await getDb().insert(transfers).values({ id: 'ts1', orgId, deviceId, createdByUserId: 'u', path: 'x', amigaDest: 'Work:Tools/big.lha',
      sizeBytes: 10, crc32: 0, blobSha256: 's', status: 'sending', expiresAt: at(9999) });
    expect(await copyMoving(getDb(), deviceId, at(30))).toBe('Work:Tools/big.lha');
    const p = await requestListing(getDb(), { orgId, deviceId, kind: 'dir', amigaPath: 'Work:', fresh: false }, at(1));
    await expireStale(getDb(), at(59));
    expect((await rowOf(ridOf(p as { state: string; row?: { id: string } }))).status).toBe('waiting');
    expect(await copyMoving(getDb(), deviceId, at(61))).toBeNull();
    await getDb().delete(transfers);
    await getDb().insert(amigaUploads).values({ id: 'up1', orgId, deviceId, path: 'Up.txt', sizeBytes: 5, amigaDate: '1.0.0', expiresAt: at(9999) });
    expect(await copyMoving(getDb(), deviceId, at(30))).toBe('Up.txt');
    await getDb().delete(amigaUploads);
  });
});
