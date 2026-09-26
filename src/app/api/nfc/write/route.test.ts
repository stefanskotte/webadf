// Route tests for /api/nfc/write, the fob button's server half. The store is
// mocked (its SQL is exercised by e2e/nfc-fob-button.spec.ts against the real
// database); what is tested here is the route's own logic -- which board,
// which answer, and that a foreign id is indistinguishable from an unknown one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NFC_WRITE_TTL_MS } from '@/lib/nfc/rules';

const ORG = 'org-1';
vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: ORG, userId: 'user-1', email: 'a@b.test' }),
}));

type Dev = { id: string; name: string; nfcReader: string | null };
type WriteRow = {
  nfcWriteSeq: number; nfcWriteExpiresAt: Date | null;
  nfcWriteResultSeq: number | null; nfcWriteResult: string | null; nfcWriteResultUid: string | null;
};
const listNfcDevices = vi.fn<(orgId: string) => Promise<Dev[]>>();
const readDiskForNfc = vi.fn<(orgId: string, diskId: string) => Promise<{ title: string; diskNo: number } | null>>();
const requestNfcWrite = vi.fn<(orgId: string, deviceId: string, diskId: string, now: Date) => Promise<number | null>>();
const readNfcWriteState = vi.fn<(orgId: string, deviceId: string) => Promise<WriteRow | null>>();
const cancelNfcWrite = vi.fn<(deviceId: string, seq: number) => Promise<void>>(async () => {});
vi.mock('@/lib/nfc/store', () => ({
  listNfcDevices: (o: string) => listNfcDevices(o),
  readDiskForNfc: (o: string, d: string) => readDiskForNfc(o, d),
  requestNfcWrite: (o: string, dev: string, d: string, n: Date) => requestNfcWrite(o, dev, d, n),
  readNfcWriteState: (o: string, dev: string) => readNfcWriteState(o, dev),
  cancelNfcWrite: (dev: string, s: number) => cancelNfcWrite(dev, s),
}));

const DISK = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const reader = (id: string, name = `Board ${id}`): Dev => ({ id, name, nfcReader: 'present' });
const req = (method: string, body?: unknown, qs = '') => new Request(`http://test/api/nfc/write${qs}`, {
  method, headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const row = (over: Partial<WriteRow> = {}): WriteRow => ({
  nfcWriteSeq: 7, nfcWriteExpiresAt: new Date(Date.now() + NFC_WRITE_TTL_MS),
  nfcWriteResultSeq: null, nfcWriteResult: null, nfcWriteResultUid: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listNfcDevices.mockResolvedValue([reader('dev-1', 'Amiga 500')]);
  readDiskForNfc.mockResolvedValue({ title: 'Turrican II', diskNo: 1 });
  requestNfcWrite.mockResolvedValue(7);
  readNfcWriteState.mockResolvedValue(row());
});

describe('POST /api/nfc/write', () => {
  it('arms the only board with a reader and says which', async () => {
    const { POST } = await import('./route');
    const res = await POST(req('POST', { diskId: DISK }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seq: 7, deviceId: 'dev-1', deviceName: 'Amiga 500', title: 'Turrican II' });
    expect(listNfcDevices).toHaveBeenCalledWith(ORG);
    expect(requestNfcWrite).toHaveBeenCalledWith(ORG, 'dev-1', DISK, expect.any(Date));
  });
  it('arms the named board when several have readers', async () => {
    listNfcDevices.mockResolvedValue([reader('dev-1'), reader('dev-2', 'Kitchen')]);
    const { POST } = await import('./route');
    const res = await POST(req('POST', { diskId: DISK, deviceId: 'dev-2' }));
    expect(res.status).toBe(200);
    expect((await res.json()).deviceName).toBe('Kitchen');
    expect(requestNfcWrite).toHaveBeenCalledWith(ORG, 'dev-2', DISK, expect.any(Date));
  });
  it('asks for a board rather than guess between two readers', async () => {
    listNfcDevices.mockResolvedValue([reader('dev-1'), reader('dev-2')]);
    const { POST } = await import('./route');
    const res = await POST(req('POST', { diskId: DISK }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'device_required' });
    expect(requestNfcWrite).not.toHaveBeenCalled();
  });
  it('refuses no_reader when the only board has none, and arms nothing', async () => {
    listNfcDevices.mockResolvedValue([{ id: 'dev-1', name: 'A', nfcReader: 'absent' }]);
    const { POST } = await import('./route');
    const res = await POST(req('POST', { diskId: DISK }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_reader' });
    expect(requestNfcWrite).not.toHaveBeenCalled();
  });
  it('refuses no_reader for a named board without one', async () => {
    listNfcDevices.mockResolvedValue([{ id: 'dev-1', name: 'A', nfcReader: null }, reader('dev-2')]);
    const { POST } = await import('./route');
    const res = await POST(req('POST', { diskId: DISK, deviceId: 'dev-1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_reader' });
  });
  it("answers a foreign or unknown board and a foreign or unknown disk identically", async () => {
    const { POST } = await import('./route');
    // Another org's board is simply not in this org's list.
    const foreignDevice = await POST(req('POST', { diskId: DISK, deviceId: 'dev-other-org' }));
    readDiskForNfc.mockResolvedValueOnce(null);
    const foreignDisk = await POST(req('POST', { diskId: DISK }));
    // The disk vanished between the read and the arm: still the same answer.
    requestNfcWrite.mockResolvedValueOnce(null);
    const raced = await POST(req('POST', { diskId: DISK }));
    const bodies = await Promise.all([foreignDevice, foreignDisk, raced].map((r) => r.json()));
    expect([foreignDevice.status, foreignDisk.status, raced.status]).toEqual([404, 404, 404]);
    expect(bodies).toEqual([{ error: 'not_found' }, { error: 'not_found' }, { error: 'not_found' }]);
    expect(readDiskForNfc).toHaveBeenCalledWith(ORG, DISK);
  });
  it.each([{}, null, { diskId: 'nope' }, { diskId: DISK.toUpperCase() }, { diskId: DISK, deviceId: 5 }])(
    'refuses a malformed body %j with 400 before the store', async (body) => {
      const { POST } = await import('./route');
      const res = await POST(req('POST', body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
      expect(listNfcDevices).not.toHaveBeenCalled();
    });
});

describe('GET /api/nfc/write', () => {
  const get = async (qs: string) => {
    const { GET } = await import('./route');
    return GET(req('GET', undefined, qs));
  };
  it('is waiting while the request is live', async () => {
    const res = await get('?deviceId=dev-1&seq=7');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'waiting' });
    expect(readNfcWriteState).toHaveBeenCalledWith(ORG, 'dev-1');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('is ok with the uid once the board answered', async () => {
    readNfcWriteState.mockResolvedValue(row({ nfcWriteResultSeq: 7, nfcWriteResult: 'ok', nfcWriteResultUid: '2419B601' }));
    expect(await (await get('?deviceId=dev-1&seq=7')).json()).toEqual({ state: 'ok', uid: '2419B601' });
  });
  it('is failed with the reason', async () => {
    readNfcWriteState.mockResolvedValue(row({ nfcWriteResultSeq: 7, nfcWriteResult: 'locked', nfcWriteResultUid: 'AA' }));
    expect(await (await get('?deviceId=dev-1&seq=7')).json()).toEqual({ state: 'failed', reason: 'locked', uid: 'AA' });
  });
  it('is superseded when a newer request replaced it', async () => {
    readNfcWriteState.mockResolvedValue(row({ nfcWriteSeq: 8 }));
    expect(await (await get('?deviceId=dev-1&seq=7')).json()).toEqual({ state: 'superseded' });
  });
  it('is expired after the expiry with no answer', async () => {
    readNfcWriteState.mockResolvedValue(row({ nfcWriteExpiresAt: new Date(Date.now() - 1) }));
    expect(await (await get('?deviceId=dev-1&seq=7')).json()).toEqual({ state: 'expired' });
  });
  it('answers not_found for a board outside the org, and for a seq never issued', async () => {
    readNfcWriteState.mockResolvedValueOnce(null);
    const foreign = await get('?deviceId=dev-x&seq=7');
    const future = await get('?deviceId=dev-1&seq=99');
    expect([foreign.status, future.status]).toEqual([404, 404]);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
    expect(await future.json()).toEqual({ error: 'not_found' });
  });
  it.each(['', '?deviceId=dev-1', '?seq=7', '?deviceId=dev-1&seq=0', '?deviceId=dev-1&seq=x'])(
    'refuses %s with 400', async (qs) => {
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(readNfcWriteState).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/nfc/write', () => {
  const del = async (body: unknown) => {
    const { DELETE } = await import('./route');
    return DELETE(req('DELETE', body));
  };
  it('cancels exactly that seq on this org\'s board', async () => {
    const res = await del({ deviceId: 'dev-1', seq: 7 });
    expect(res.status).toBe(204);
    expect(readNfcWriteState).toHaveBeenCalledWith(ORG, 'dev-1');
    expect(cancelNfcWrite).toHaveBeenCalledWith('dev-1', 7);
  });
  it('never touches a board outside the org', async () => {
    readNfcWriteState.mockResolvedValueOnce(null);
    const res = await del({ deviceId: 'dev-other-org', seq: 7 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(cancelNfcWrite).not.toHaveBeenCalled();
  });
  it.each([{}, null, { deviceId: 'dev-1' }, { deviceId: 'dev-1', seq: 0 }, { deviceId: 'dev-1', seq: '7' }])(
    'refuses %j with 400', async (body) => {
      const res = await del(body);
      expect(res.status).toBe(400);
      expect(cancelNfcWrite).not.toHaveBeenCalled();
    });
});
