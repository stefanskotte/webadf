import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/session', () => ({ requireOrg: async () => ({ orgId: 'org-1' }) }));
const setDesired = vi.fn();
vi.mock('@/lib/mount', () => ({ setDesired: (...a: unknown[]) => setDesired(...a) }));
const mountToDf1 = vi.fn();
vi.mock('@/lib/df1-store', () => ({ mountToDf1: (...a: unknown[]) => mountToDf1(...a) }));
const drivesBefore = vi.fn();
vi.mock('@/lib/mount-undo', () => ({ drivesBefore: (...a: unknown[]) => drivesBefore(...a) }));
// Local disks here; the hidden-disk re-check (R-6a) runs against a real database in src/app/api/remote/remote-api.db.test.ts.
const recheckHidden = vi.fn<(...a: unknown[]) => Promise<{ hidden: boolean }>>(async () => ({ hidden: false }));
vi.mock('@/lib/remote/remount', () => ({ recheckHidden: (...a: unknown[]) => recheckHidden(...a) }));
const ownsDevice = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock('@/lib/mount-http', async (orig) => ({
  ...(await orig<typeof import('@/lib/mount-http')>()), orgOwnsDevice: (...a: unknown[]) => ownsDevice(...a),
}));

const post = async (body: unknown) => {
  const { POST } = await import('./route');
  return POST(new Request('http://test/api/devices/dev-1/mount', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: 'dev-1' }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  drivesBefore.mockResolvedValue({ df0: 'disk-held', df1: null });
  ownsDevice.mockResolvedValue(true);
});

describe('POST /api/devices/[id]/mount -- the board first (final review 8)', () => {
  it("a board that is not this team's is 404 before any owner is asked", async () => {
    ownsDevice.mockResolvedValue(false);
    const res = await post({ diskId: 'disk-x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(ownsDevice).toHaveBeenCalledWith('org-1', 'dev-1');
    expect(recheckHidden).not.toHaveBeenCalled();
    expect(setDesired).not.toHaveBeenCalled();
  });
  it("this team's board: the hidden re-check runs", async () => {
    setDesired.mockResolvedValue({ ok: true, version: 3 });
    await post({ diskId: 'disk-x' });
    expect(recheckHidden).toHaveBeenCalledWith('org-1', 'disk-x');
  });
});

describe('POST /api/devices/[id]/mount -- drive', () => {
  it('no drive, or df0: DF0 as before', async () => {
    setDesired.mockResolvedValue({ ok: true, version: 3 });
    expect((await post({ diskId: 'disk-x' })).status).toBe(200);
    expect((await post({ diskId: 'disk-x', drive: 'df0' })).status).toBe(200);
    expect(setDesired).toHaveBeenCalledTimes(2);
    expect(mountToDf1).not.toHaveBeenCalled();
  });
  it('df1: mountToDf1, and its version', async () => {
    mountToDf1.mockResolvedValue({ ok: true, version: 7 });
    const res = await post({ diskId: 'disk-x', drive: 'df1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 7, undo: { diskId: null } });   // DF1 had no pick: Undo ejects it
    expect(mountToDf1).toHaveBeenCalledWith('org-1', 'dev-1', 'disk-x');
    expect(setDesired).not.toHaveBeenCalled();
  });
  it('df1 refused: 409 with the reason in words; not_found: 404', async () => {
    mountToDf1.mockResolvedValue({ ok: false, reason: 'not_dd' });
    const r1 = await post({ diskId: 'disk-x', drive: 'df1' });
    expect(r1.status).toBe(409);
    expect(await r1.json()).toEqual({ error: 'not_dd', reason: 'DF1 takes standard DD disks only' });
    mountToDf1.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await post({ diskId: 'disk-x', drive: 'df1' })).status).toBe(404);
  });
  it("DF0's answer names the confirmed disk Undo puts back (A3), read for this org's board", async () => {
    setDesired.mockResolvedValue({ ok: true, version: 3 });
    const res = await post({ diskId: 'disk-x' });
    expect(await res.json()).toEqual({ version: 3, undo: { diskId: 'disk-held' } });
    expect(drivesBefore).toHaveBeenCalledWith('org-1', 'dev-1');
  });
  it('an unknown drive is a 400', async () => {
    expect((await post({ diskId: 'disk-x', drive: 'df2' })).status).toBe(400);
  });
});
