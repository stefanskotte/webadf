// Route tests for POST /api/disks/[id]/restore.
//
// restoreVersion itself is NOT re-exercised here -- it has its own thorough
// unit tests in src/lib/disk-history/restore.test.ts (the entitlement
// boundary, the holder check, materialise, recordVersion, repointLateMounts,
// all against real ADF bytes). What is proven here is the route's OWN logic:
// body parsing (malformed JSON vs a schema failure) and the mapping from
// restoreVersion's outcome to a response -- in particular the 409 fork
// between a held disk ({error:'mounted', reason}) and a stale head
// ({error:'conflict'}), which is what Task 5's UI codes against.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RestoreOutcome } from '@/lib/disk-history/restore';

const restoreVersion = vi.fn<(orgId: string, diskId: string, seq: number, userId: string | null) => Promise<RestoreOutcome>>();
vi.mock('@/lib/disk-history/restore', () => ({ restoreVersion }));

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: ORG_ID, userId: USER_ID, email: 'a@b.test' }),
}));

const DISK_ID = 'disk-1';

function makeRequest(body: unknown): Request {
  return new Request(`http://test/api/disks/${DISK_ID}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/disks/[id]/restore', () => {
  it('answers invalid_json for a body that does not parse as JSON at all', async () => {
    const { POST } = await import('./route');
    const request = makeRequest('{not json');
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
    expect(restoreVersion).not.toHaveBeenCalled();
  });

  it('answers invalid_body for well-formed JSON that fails the schema', async () => {
    const { POST } = await import('./route');
    const request = makeRequest({ seq: 'first' }); // seq must be a number
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(400);
    const responseBody = await response.json();
    expect(responseBody.error).toBe('invalid_body');
    expect(restoreVersion).not.toHaveBeenCalled();
  });

  it('rejects a negative seq the same way', async () => {
    const { POST } = await import('./route');
    const request = makeRequest({ seq: -1 });
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_body');
    expect(restoreVersion).not.toHaveBeenCalled();
  });

  it('calls restoreVersion with the org, disk id, parsed seq and user, and returns 200 on success', async () => {
    restoreVersion.mockResolvedValue({ ok: true, sha256: 'f'.repeat(64), seq: 4 });

    const { POST } = await import('./route');
    const request = makeRequest({ seq: 2 });
    const response = await POST(request, { params: Promise.resolve({ id: DISK_ID }) });

    expect(restoreVersion).toHaveBeenCalledWith(ORG_ID, DISK_ID, 2, USER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha256: 'f'.repeat(64), seq: 4 });
  });

  it('maps a held disk to 409 {error: "mounted", reason}', async () => {
    restoreVersion.mockResolvedValue({ ok: false, status: 409, reason: 'mounted on "Amiga 500 #1"' });

    const { POST } = await import('./route');
    const response = await POST(makeRequest({ seq: 0 }), { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'mounted', reason: 'mounted on "Amiga 500 #1"' });
  });

  it('maps a stale head to 409 {error: "conflict"} -- the OTHER 409, not the mounted shape', async () => {
    restoreVersion.mockResolvedValue({ ok: false, status: 409, reason: 'conflict' });

    const { POST } = await import('./route');
    const response = await POST(makeRequest({ seq: 0 }), { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'conflict' });
  });

  it('maps an unknown disk or version to 404', async () => {
    restoreVersion.mockResolvedValue({ ok: false, status: 404, reason: 'not_found' });

    const { POST } = await import('./route');
    const response = await POST(makeRequest({ seq: 99 }), { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('maps a broken chain to 500', async () => {
    restoreVersion.mockResolvedValue({ ok: false, status: 500, reason: 'broken_history' });

    const { POST } = await import('./route');
    const response = await POST(makeRequest({ seq: 3 }), { params: Promise.resolve({ id: DISK_ID }) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'broken_history' });
  });
});
