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
vi.mock('@/lib/step-up-throttle', () => ({
  lockoutRemaining: async () => 0, recordFailure: async () => 0, clearFailures: async () => undefined,
}));
const cancelFirmwareUpdate = vi.fn(async (_org: string, ids: string[]) => ids.length);
vi.mock('@/lib/firmware-update', () => ({ requestFirmwareUpdate: vi.fn(), cancelFirmwareUpdate }));

const ids = (n: number) => Array.from({ length: n }, (_, i) => `dev-${i}`);
const req = (method: string, body: unknown) => new Request('http://test/api/devices/firmware-update', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const VERSION = '1.2.0+gabc1234';

beforeEach(() => { vi.clearAllMocks(); });

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
