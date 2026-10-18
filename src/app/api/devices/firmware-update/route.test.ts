// Route tests for POST/DELETE /api/devices/firmware-update, for one thing
// only: the batch cap the schema enforces is the SAME MAX_UPDATE_BATCH the
// update bar reads. requestFirmwareUpdate and the password check are faked;
// a wrong password answering 401 is how a test tells "the body parsed" from
// "the body was refused" without touching a database.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_UPDATE_BATCH } from '@/lib/firmware-update-rules';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
const verifyPassword = vi.fn(async () => false);
vi.mock('@/lib/step-up', () => ({ verifyPassword }));
const recordFailure = vi.fn<(u: string) => Promise<number>>(async () => 0);
vi.mock('@/lib/step-up-throttle', () => ({
  lockoutRemaining: async () => 0, recordFailure: (u: string) => recordFailure(u), clearFailures: async () => undefined,
}));
const cancelFirmwareUpdate = vi.fn(async (_org: string, ids: string[]) => ids.length);
const requestFirmwareUpdate = vi.fn<(o: string, u: string, ids: string[], v: string) => Promise<unknown>>(async (_o, _u, ids) => ({ ok: true as const, count: ids.length }));
vi.mock('@/lib/firmware-update', () => ({
  requestFirmwareUpdate: (o: string, u: string, ids: string[], v: string) => requestFirmwareUpdate(o, u, ids, v),
  cancelFirmwareUpdate,
}));
// The user's own "don't ask for my password" preference. Off unless a test says otherwise.
let skipPassword = false;
const getUserPrefs = vi.fn<(u: string) => Promise<unknown>>(async () => ({ ...DEFAULT_PREFS, firmware: { skipPassword } }));
vi.mock('@/lib/user-prefs', () => ({ getUserPrefs: (u: string) => getUserPrefs(u), setUserPrefs: vi.fn() }));
const { DEFAULT_PREFS } = await import('@/lib/user-prefs-schema');

const ids = (n: number) => Array.from({ length: n }, (_, i) => `dev-${i}`);
const req = (method: string, body: unknown) => new Request('http://test/api/devices/firmware-update', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const VERSION = '1.2.0+gabc1234';

beforeEach(() => { vi.clearAllMocks(); skipPassword = false; });

describe('the firmware-update batch cap', () => {
  it('accepts exactly MAX_UPDATE_BATCH devices (reaches the password check)', async () => {
    const { POST } = await import('./route');
    const res = await POST(req('POST', { deviceIds: ids(MAX_UPDATE_BATCH), version: VERSION, password: 'x' }));
    expect(res.status).toBe(401);
    expect(verifyPassword).toHaveBeenCalledOnce();
  });

  it('refuses one more with 400 before the password is checked', async () => {
    const { POST } = await import('./route');
    const res = await POST(req('POST', { deviceIds: ids(MAX_UPDATE_BATCH + 1), version: VERSION, password: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('holds the cancel path to the same cap', async () => {
    const { DELETE } = await import('./route');
    expect((await DELETE(req('DELETE', { deviceIds: ids(MAX_UPDATE_BATCH) }))).status).toBe(200);
    expect((await DELETE(req('DELETE', { deviceIds: ids(MAX_UPDATE_BATCH + 1) }))).status).toBe(400);
  });
});

describe('the per-user "don\'t ask for my password" preference', () => {
  it('on: no password needed -- the update goes ahead through the existing flow', async () => {
    skipPassword = true;
    const { POST } = await import('./route');
    const res = await POST(req('POST', { deviceIds: ['dev-1'], version: VERSION }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });
    expect(getUserPrefs).toHaveBeenCalledWith('user-1');
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(requestFirmwareUpdate).toHaveBeenCalledWith('org-1', 'user-1', ['dev-1'], VERSION);
  });

  it('on: the version and device guards still answer as before', async () => {
    skipPassword = true;
    requestFirmwareUpdate.mockResolvedValueOnce({ ok: false, kind: 'unknown_device' } as never);
    const { POST } = await import('./route');
    expect((await POST(req('POST', { deviceIds: ['dev-1'], version: VERSION }))).status).toBe(404);
    requestFirmwareUpdate.mockResolvedValueOnce({ ok: false, kind: 'refused', refusals: [{ deviceId: 'dev-1', name: 'A', reason: 'would_roll_back' }] } as never);
    const refused = await POST(req('POST', { deviceIds: ['dev-1'], version: VERSION }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).refusals[0].reason).toBe('would_roll_back');
    expect((await POST(req('POST', { deviceIds: [], version: VERSION }))).status).toBe(400);
    expect((await POST(req('POST', { deviceIds: ['dev-1'], version: '' }))).status).toBe(400);
  });

  it('off: a missing password is refused exactly as before, and nothing is requested', async () => {
    const { POST } = await import('./route');
    const res = await POST(req('POST', { deviceIds: ['dev-1'], version: VERSION }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(requestFirmwareUpdate).not.toHaveBeenCalled();
  });

  it('off: a wrong password is a counted 401 exactly as before', async () => {
    const { POST } = await import('./route');
    const res = await POST(req('POST', { deviceIds: ['dev-1'], version: VERSION, password: 'nope' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_password' });
    expect(recordFailure).toHaveBeenCalledWith('user-1');
    expect(requestFirmwareUpdate).not.toHaveBeenCalled();
  });

  it('a preference read that throws asks for the password (fails safe)', async () => {
    getUserPrefs.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('./route');
    const res = await POST(req('POST', { deviceIds: ['dev-1'], version: VERSION }));
    expect(res.status).toBe(400);
    expect(requestFirmwareUpdate).not.toHaveBeenCalled();
  });
});
