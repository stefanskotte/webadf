import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';

// A database of its own (the shared one is the live one).
const base = process.env.TEST_DATABASE_URL!;
const DB = 'webadf_req_routes_test';
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
const { eq } = await import('drizzle-orm');
const { organization } = await import('@/db/schema/auth');
const { devices } = await import('@/db/schema/devices');
const { remoteRequests } = await import('@/db/schema/remote-requests');
const { hashDeviceToken } = await import('@/lib/device-token');
const { requestListing } = await import('@/lib/remote-requests');
const { recordSendRx } = await import('@/lib/transfers');
const { GET } = await import('./route');
const { POST } = await import('./[rid]/route');

const TOKEN = 'req-routes-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const rowOf = async (id: string) => (await getDb().select().from(remoteRequests).where(eq(remoteRequests.id, id)))[0];
const ask = async (deviceId: string, orgId: string, kind: 'vols' | 'dir', amigaPath = '') => {
  const s = await requestListing(getDb(), { orgId, deviceId, kind, amigaPath, fresh: true });
  if (s.state !== 'pending') throw new Error('not pending');
  return s.row.id;
};
const post = (rid: string, body: unknown, headers: Record<string, string> = auth) =>
  POST(new Request(`http://x/api/device/req/${rid}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ rid }) });
// What the firmware's amigaJson writes: every char above 0x7F as \u00XX.
const escaped = (o: unknown) => JSON.stringify(o).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

beforeAll(async () => {
  await admin(`drop database if exists ${DB} with (force)`);
  await admin(`create database ${DB}`);
  await migrate(getDb(), { migrationsFolder: 'drizzle' });
  const db = getDb();
  await db.insert(organization).values([{ id: 'qo1', name: 'qo1', slug: 'qo1', createdAt: new Date() }, { id: 'qo2', name: 'qo2', slug: 'qo2', createdAt: new Date() }]);
  await db.insert(devices).values([
    { id: 'qb1', orgId: 'qo1', name: 'A500', tokenHash: hashDeviceToken(TOKEN) },
    { id: 'qb2', orgId: 'qo2', name: 'Other', tokenHash: hashDeviceToken('other-token') },
  ]);
});
afterAll(async () => {
  await closeDb();
  await admin(`drop database if exists ${DB} with (force)`);
});
beforeEach(async () => { await getDb().delete(remoteRequests); });

describe('GET /api/device/req', () => {
  it('answers the waiting requests as Latin-1 lines and marks them sent', async () => {
    const id1 = await ask('qb1', 'qo1', 'vols');
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await ask('qb1', 'qo1', 'dir', 'Work:Würfel');
    const res = await GET(new Request('http://x/api/device/req', { headers: auth }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=latin1');
    expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).toBe(`VOLS ${id1}\nDIR ${id2} 11:Work:Würfel\n`);
    expect((await rowOf(id1)).status).toBe('sent');
    expect((await rowOf(id2)).status).toBe('sent');
  });
  it('answers an empty body when nothing waits', async () => {
    const res = await GET(new Request('http://x/api/device/req', { headers: auth }));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });
  it('is 401 without a token', async () => {
    expect((await GET(new Request('http://x/api/device/req'))).status).toBe(401);
  });
});

describe('POST /api/device/req/<rid>', () => {
  const sent = async () => {
    const id = await ask('qb1', 'qo1', 'dir', 'Work:');
    await GET(new Request('http://x/api/device/req', { headers: auth }));
    return id;
  };
  it('takes a valid last piece: 204 and the row is done', async () => {
    const id = await sent();
    const r = await post(id, { piece: 0, lines: [`DONE ${id} 0`], last: true });
    expect(r.status).toBe(204);
    expect((await rowOf(id)).status).toBe('done');
  });
  it('keeps another board\'s request: 404 and the row unchanged', async () => {
    const id = await ask('qb2', 'qo2', 'vols');
    await GET(new Request('http://x/api/device/req', { headers: { authorization: 'Bearer other-token' } }));
    const r = await post(id, { piece: 0, lines: [`DONE ${id} 0`], last: true });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ code: 'gone' });
    expect((await rowOf(id)).status).toBe('sent');
  });
  it('answers a gap in the pieces with 409 order', async () => {
    const id = await sent();
    const r = await post(id, { piece: 3, lines: [], last: false });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ code: 'order' });
  });
  it('refuses a malformed body with 400, leaving the row sent', async () => {
    const id = await sent();
    const bad = [
      { piece: -1, lines: [], last: true },
      { piece: 0, lines: ['x'.repeat(641)], last: true },
      { piece: 0, lines: Array.from({ length: 401 }, () => 'x'), last: true },
      { piece: 0, lines: [], last: 'yes' },
      'not json',
    ];
    for (const b of bad) expect((await post(id, b)).status).toBe(400);
    expect((await rowOf(id)).status).toBe('sent');
  });
  it('is 404 for a request id that is not an id, and 401 without a token', async () => {
    expect((await post('a/b c', { piece: 0, lines: [], last: true })).status).toBe(404);
    const id = await sent();
    expect((await post(id, { piece: 0, lines: [], last: true }, {})).status).toBe(401);
  });
  it('reads the board\'s \\u00XX escapes once: a Würfel entry is stored as Würfel', async () => {
    const id = await sent();
    const body = escaped({ piece: 0, lines: [`ENT ${id} f 10 0 1.0.0 6:Würfel 0:`, `DONE ${id} 1`], last: true });
    expect(body).toContain('\\u00fc');
    expect((await post(id, body)).status).toBe(204);
    const row = await rowOf(id);
    expect((row.answer as { entries: { name: string }[] }).entries[0].name).toBe('Würfel');
  });
});

describe('recordSendRx with Transfer\'s capabilities', () => {
  const caps = async () => (await getDb().select({ p: devices.rxProto, b: devices.browseOn }).from(devices).where(eq(devices.id, 'qb1')))[0];
  it('writes rx_proto and browse_on, and a change of either inside the 30 s throttle still writes', async () => {
    const t = new Date('2026-10-30T12:00:00Z');
    await recordSendRx(getDb(), 'qb1', 'c', t);
    expect(await caps()).toEqual({ p: null, b: false });
    await recordSendRx(getDb(), 'qb1', 'c', new Date(t.getTime() + 1000), { proto: 3, browse: true });
    expect(await caps()).toEqual({ p: 3, b: true });
    await recordSendRx(getDb(), 'qb1', 'c', new Date(t.getTime() + 2000), { proto: 3, browse: false });
    expect(await caps()).toEqual({ p: 3, b: false });
    await recordSendRx(getDb(), 'qb1', 'c', new Date(t.getTime() + 3000), { proto: 2, browse: false });
    expect(await caps()).toEqual({ p: 2, b: false });
  });
});
