// Route tests for GET /api/device/poll, for the parts the long-hold loop
// still lets a unit test reach: nfcAck parsing (task 4, spec §5.3) and
// whether nfcWrite is included. Every case below resolves on the FIRST
// tick -- either nfcMoved or firmwareMoved is engineered to be true, so the
// route returns immediately and the test never has to wait through the
// route's real setTimeout hold. The "nothing moved, hold to 204" path is
// NOT covered here: that needs the loop to actually sleep for up to 25 s,
// which is what src/app/api/device/poll's e2e coverage (task 8) exercises
// end to end instead.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PollTick, DesiredState } from '@/lib/mount';
import { DC_TITLE_MAX } from '@/lib/device-limits';

const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>(
  async () => ({ deviceId: 'dev-1', orgId: 'org-1' }),
);
const touchLastSeen = vi.fn(async () => undefined);
const readPollTick = vi.fn<() => Promise<PollTick | null>>();
const readDesired = vi.fn<() => Promise<DesiredState | null>>(
  async () => ({ version: 1, desired: null }),
);
const readFirmwareInstruction = vi.fn(async () => null);

vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: () => null,
}));
vi.mock('@/lib/mount', () => ({
  touchLastSeen: () => touchLastSeen(),
  readPollTick: () => readPollTick(),
  readDesired: () => readDesired(),
  readFirmwareInstruction: () => readFirmwareInstruction(),
}));

type NfcRow = {
  nfcWriteSeq: number; nfcWriteDiskId: string | null;
  nfcWriteExpiresAt: Date | null; nfcWriteResultSeq: number | null; title: string | null;
};
const readNfcWriteRow = vi.fn<() => Promise<NfcRow | null>>();
vi.mock('@/lib/nfc/store', () => ({ readNfcWriteRow: () => readNfcWriteRow() }));

const get = (qs = '') => new Request(`http://test/api/device/poll${qs}`);

const baseTick = (over: Partial<PollTick> = {}): PollTick => ({
  version: 1, instructionVersion: 0, instructionAck: 0, nfcWriteSeq: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireDevice.mockResolvedValue({ deviceId: 'dev-1', orgId: 'org-1' });
  readDesired.mockResolvedValue({ version: 1, desired: null });
  readFirmwareInstruction.mockResolvedValue(null);
});

describe('GET /api/device/poll -- nfcAck and nfcWrite', () => {
  it('defaults a missing nfcAck to 0, and wakes on the first tick when nfcWriteSeq has moved', async () => {
    readPollTick.mockResolvedValue(baseTick({ nfcWriteSeq: 1 }));
    readNfcWriteRow.mockResolvedValue({
      nfcWriteSeq: 1, nfcWriteDiskId: 'disk-1',
      nfcWriteExpiresAt: new Date(Date.now() + 60_000), nfcWriteResultSeq: null,
      title: 'Turrican II',
    });
    const { GET } = await import('./route');
    // since=1 matches the tick's version, so ONLY the nfcWriteSeq cursor
    // (never acknowledged: no ?nfcAck= at all) can be what wakes this.
    const res = await GET(get('?since=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nfcWrite: { seq: 1, diskId: 'disk-1', title: 'Turrican II' },
    });
  });

  it('parses nfcAck exactly like since: a garbled value falls back to 0, same as absent', async () => {
    readPollTick.mockResolvedValue(baseTick({ nfcWriteSeq: 1 }));
    readNfcWriteRow.mockResolvedValue({
      nfcWriteSeq: 1, nfcWriteDiskId: 'disk-1',
      nfcWriteExpiresAt: new Date(Date.now() + 60_000), nfcWriteResultSeq: null,
      title: 'Turrican II',
    });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&nfcAck=1abc'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nfcWrite: { seq: 1, diskId: 'disk-1', title: 'Turrican II' },
    });
  });

  it('omits nfcWrite once nfcAck has caught up to nfcWriteSeq, even on a response woken by something else', async () => {
    // firmwareMoved forces the immediate return here; nfcAck=1 == nfcWriteSeq
    // means nfcMoved is false, so readNfcWriteRow must not even be consulted.
    readPollTick.mockResolvedValue(baseTick({ nfcWriteSeq: 1, instructionVersion: 1, instructionAck: 0 }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&nfcAck=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('nfcWrite');
    expect(readNfcWriteRow).not.toHaveBeenCalled();
  });

  it('bounds a long title to DC_TITLE_MAX before it goes on the wire (review round 1 finding)', async () => {
    // readNfcWriteRow can hand back games.title raw -- an unbounded `text`
    // column -- so the route itself must be what enforces the bound, the
    // same way readDesired bounds `game`. Mocking store.ts here means this
    // test only proves anything if the ROUTE does the slicing; a title this
    // long sailing through unbounded is exactly what review round 1 flagged
    // (a body over DC_POLL_BODY_BYTES the firmware can never parse at all).
    const longTitle = 'x'.repeat(1000);
    readPollTick.mockResolvedValue(baseTick({ nfcWriteSeq: 1 }));
    readNfcWriteRow.mockResolvedValue({
      nfcWriteSeq: 1, nfcWriteDiskId: 'disk-1',
      nfcWriteExpiresAt: new Date(Date.now() + 60_000), nfcWriteResultSeq: null,
      title: longTitle,
    });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nfcWrite.title.length).toBeLessThanOrEqual(DC_TITLE_MAX);
    expect(body.nfcWrite.title).toBe(longTitle.slice(0, DC_TITLE_MAX));
  });

  it('delivers a disarm (diskId and title both null) for an expired request, so the board can catch up', async () => {
    readPollTick.mockResolvedValue(baseTick({ nfcWriteSeq: 2 }));
    readNfcWriteRow.mockResolvedValue({
      nfcWriteSeq: 2, nfcWriteDiskId: 'disk-1',
      nfcWriteExpiresAt: new Date(Date.now() - 1000), // expired
      nfcWriteResultSeq: null, title: 'Turrican II',
    });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nfcWrite: { seq: 2, diskId: null, title: null },
    });
  });
});
