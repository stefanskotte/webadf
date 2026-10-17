// GET /api/device/image/net/<sha256> (pre-flight I3): the driver disk for a board's SLOT_NET, as a DD WFAD,
// without an entitlement; and (spec 2026-10-14 §4.3) a standard DD ADF of the board's own organization, which
// needs the entitlement AND a DD ADF disk row. Nothing else.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PAULANET_DISK_PREVIOUS, PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';
import { ADF_BYTES } from '@/lib/adfmfm';

class FakeAuthError extends Error {}
const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>();
vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: (e: unknown) =>
    e instanceof FakeAuthError ? Response.json({ error: 'unauthorized' }, { status: 401 }) : null,
}));
const read = vi.fn<(sha: string) => Promise<Uint8Array>>();
vi.mock('@/lib/storage', () => ({ diskStore: { read: (sha: string) => read(sha) } }));
// Two selects at most, in order: the entitlement, then the disk row that is a standard DD ADF (spec 2026-10-14
// §4.3). The driver disk is served without any database read; every WHERE is kept and rendered back to SQL.
const rows: unknown[][] = [];
const wheres: unknown[] = [];
const select = vi.fn(() => {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = (w: unknown) => { wheres.push(w); return c; };
  c.limit = () => Promise.resolve(rows.shift() ?? []);
  return c;
});
vi.mock('@/db', () => ({ getDb: () => ({ select }) }));

const call = async (sha: string) => {
  const { GET } = await import('./route');
  return GET(new Request(`http://test/api/device/image/net/${sha}`), { params: Promise.resolve({ sha256: sha }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  rows.length = 0; wheres.length = 0;
  requireDevice.mockResolvedValue({ deviceId: 'dev-1', orgId: 'org-1' });
});

describe('GET /api/device/image/net/<sha256>', () => {
  it('serves the driver disk as a DD WFAD (11 sectors), with no entitlement', async () => {
    const adf = new Uint8Array(ADF_BYTES).map((_, i) => (i * 7) & 0xff);
    read.mockResolvedValue(adf);
    const res = await call(PAULANET_DISK_SHA256);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(16 + ADF_BYTES));
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body.slice(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x0b, 0, 0, 0]);
    expect(body.slice(16)).toEqual(adf);
    expect(read).toHaveBeenCalledWith(PAULANET_DISK_SHA256);
    expect(select).not.toHaveBeenCalled();   // the driver disk needs no entitlement
  });

  it('serves the older driver disk too, with no entitlement: a board whose Amiga is online keeps it (R16)', async () => {
    read.mockResolvedValue(new Uint8Array(ADF_BYTES));
    const res = await call(PAULANET_DISK_PREVIOUS);
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith(PAULANET_DISK_PREVIOUS);
    expect(select).not.toHaveBeenCalled();
  });

  it('serves a standard DD ADF of the board\'s own organization as a DD WFAD (a disk mounted into DF1)', async () => {
    const sha = 'a'.repeat(64);
    rows.push([{ sha256: sha }], [{ imageFormat: 'adf', sizeBytes: ADF_BYTES }]);
    const adf = new Uint8Array(ADF_BYTES).map((_, i) => (i * 3) & 0xff);
    read.mockResolvedValue(adf);
    const res = await call(sha);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(16 + ADF_BYTES));
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body.slice(0, 16)]).toEqual([0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0, 0xa0, 0, 0, 0, 0x0b, 0, 0, 0]);
    expect(read).toHaveBeenCalledWith(sha);
    const ent = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(ent.sql).toContain('"entitlements"."org_id" = $');
    expect(ent.sql).toContain('"entitlements"."sha256" = $');
    expect(ent.params).toEqual(expect.arrayContaining(['org-1', sha]));
    const q = new PgDialect().sqlToQuery(wheres[1] as SQL);
    expect(q.sql).toContain('"disks"."org_id" = $');
    expect(q.sql).toContain('"disks"."sha256" = $');
    expect(q.sql).toContain('"disks"."image_format" = $');
    expect(q.sql).toContain('"disks"."size_bytes" = $');
    expect(q.params).toEqual(expect.arrayContaining(['org-1', sha, 'adf', ADF_BYTES]));
  });

  it('is 404 when the org has a disk row but no entitlement, and never reads the store', async () => {
    rows.push([], [{ imageFormat: 'adf', sizeBytes: ADF_BYTES }]);
    const res = await call('c'.repeat(64));
    expect(res.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('is 404 for an entitled digest no DD ADF row of the board\'s org names -- another org\'s disk, an HFE, an HD ADF -- and never reads the store', async () => {
    rows.push([{ sha256: 'b'.repeat(64) }], []);
    const res = await call('b'.repeat(64));
    expect(res.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('is 404 for a malformed digest without a database read', async () => {
    for (const sha of ['nope', PAULANET_DISK_SHA256.toUpperCase(), 'a'.repeat(63)]) {
      expect((await call(sha)).status).toBe(404);
    }
    expect(select).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('needs the device to authenticate, like the library route', async () => {
    requireDevice.mockRejectedValue(new FakeAuthError());
    const res = await call(PAULANET_DISK_SHA256);
    expect(res.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it('is 503 when the store cannot be read, 422 when the object is not a DD ADF', async () => {
    read.mockRejectedValueOnce(new Error('down'));
    expect((await call(PAULANET_DISK_SHA256)).status).toBe(503);
    read.mockResolvedValueOnce(new Uint8Array(ADF_BYTES - 1));
    expect((await call(PAULANET_DISK_SHA256)).status).toBe(422);
  });
});
