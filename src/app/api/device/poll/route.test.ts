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

const readNextForPoll = vi.fn<(deviceId: string, orgId: string) => Promise<{ diskId: string; sha256: string; diskNo: number } | null>>();
vi.mock('@/lib/next-disk', () => ({
  readNextForPoll: (deviceId: string, orgId: string) => readNextForPoll(deviceId, orgId),
}));

const get = (qs = '') => new Request(`http://test/api/device/poll${qs}`);

const baseTick = (over: Partial<PollTick> = {}): PollTick => ({
  version: 1, instructionVersion: 0, instructionAck: 0, nfcWriteSeq: 0, displayVersion: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireDevice.mockResolvedValue({ deviceId: 'dev-1', orgId: 'org-1' });
  readDesired.mockResolvedValue({ version: 1, desired: null });
  readFirmwareInstruction.mockResolvedValue(null);
  readNextForPoll.mockResolvedValue(null);
});

describe('GET /api/device/poll -- nfcAck and nfcWrite', () => {
  it('wakes on the first tick when nfcWriteSeq has moved past nfcAck=0', async () => {
    readPollTick.mockResolvedValue(baseTick({ nfcWriteSeq: 1 }));
    readNfcWriteRow.mockResolvedValue({
      nfcWriteSeq: 1, nfcWriteDiskId: 'disk-1',
      nfcWriteExpiresAt: new Date(Date.now() + 60_000), nfcWriteResultSeq: null,
      title: 'Turrican II',
    });
    const { GET } = await import('./route');
    // since=1 matches the tick's version, so ONLY the nfcWriteSeq cursor
    // (never acknowledged: nfcAck=0) can be what wakes this.
    const res = await GET(get('?since=1&nfcAck=0'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nfcWrite: { seq: 1, diskId: 'disk-1', title: 'Turrican II' },
    });
  });

  it('parses a PRESENT nfcAck exactly like since: a garbled value falls back to 0', async () => {
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
    const res = await GET(get('?since=1&nfcAck=0'));
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
    const res = await GET(get('?since=1&nfcAck=0'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nfcWrite: { seq: 2, diskId: null, title: null },
    });
  });

  it('a MISSING nfcAck means firmware that does not speak NFC: the hold holds (no wake, no nfcWrite)', async () => {
    // Firmware before 1.3.0 sends ?since= alone. Read as nfcAck=0, any
    // nfc_write_seq > 0 would wake every poll at once, forever -- that board
    // re-polls immediately and can never acknowledge. Absent must mean "not
    // an NFC board", so the only way out of this poll is the 25 s hold.
    vi.useFakeTimers();
    try {
      readPollTick.mockResolvedValue(baseTick({ nfcWriteSeq: 3 }));
      readNfcWriteRow.mockResolvedValue({
        nfcWriteSeq: 3, nfcWriteDiskId: 'disk-1',
        nfcWriteExpiresAt: new Date(Date.now() + 60_000), nfcWriteResultSeq: null,
        title: 'Turrican II',
      });
      const { GET } = await import('./route');
      let settled = false;
      const pending = GET(get('?since=1')).then((r) => { settled = true; return r; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(25_000);
      const res = await pending;
      expect(res.status).toBe(204);
      expect(readNfcWriteRow).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

const desiredDisk = {
  sha256: 'a'.repeat(64), diskId: 'd1', gameId: 'g1', game: 'Game',
  diskNo: 1, diskCount: 2, label: 'L', writeProtected: false,
};

// Every case here wakes on the FIRST tick via firmwareMoved (instructionVersion
// ahead of instructionAck), same technique as the nfcWrite tests above -- `next`
// does not depend on nfc at all, so there is no need to touch nfcAck/nfcMoved.
describe('GET /api/device/poll -- next (multi-disk plan R1)', () => {
  const wake = () => baseTick({ instructionVersion: 1, instructionAck: 0 });

  it('carries next (minimal shape) when desired is present and a next disk exists', async () => {
    readPollTick.mockResolvedValue(wake());
    readDesired.mockResolvedValue({ version: 1, desired: desiredDisk });
    readNextForPoll.mockResolvedValue({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next).toEqual({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
  });

  it('carries next: null when desired is present but there is no next disk (e.g. a single-disk title)', async () => {
    readPollTick.mockResolvedValue(wake());
    readDesired.mockResolvedValue({ version: 1, desired: desiredDisk });
    readNextForPoll.mockResolvedValue(null);
    const { GET } = await import('./route');
    const res = await GET(get('?since=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('next', null);
  });

  it('omits next entirely (not even null) when nothing is desired, and never calls readNextForPoll', async () => {
    readPollTick.mockResolvedValue(wake());
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty('next');
    expect(readNextForPoll).not.toHaveBeenCalled();
  });

  it('places next after desired in the JSON body', async () => {
    readPollTick.mockResolvedValue(wake());
    readDesired.mockResolvedValue({ version: 1, desired: desiredDisk });
    readNextForPoll.mockResolvedValue({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1'));
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(text.indexOf('"next"')).toBeGreaterThan(text.indexOf('"desired"'));
  });
});

// OLED layouts (plan Global Constraints, "the display cursor"): the board sends
// &displayAck=<n>, the highest display version it has HANDLED (applied or
// rejected). The server wakes while display_version !== displayAck and ALWAYS
// carries displayVersion in a body answering a poll that sent displayAck --
// the board reads displayVersion < its ack as a server-side reset (re-pair).
describe('GET /api/device/poll -- displayAck and displayVersion', () => {
  it('wakes on the first tick when displayVersion has moved past displayAck, and carries it', async () => {
    readPollTick.mockResolvedValue(baseTick({ displayVersion: 3 }));
    const { GET } = await import('./route');
    // since=1 matches the tick's version: only the display cursor can wake this.
    const res = await GET(get('?since=1&nfcAck=0&displayAck=2'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayVersion: 3 });
  });

  it('carries displayVersion on a body woken by something else, even when the board is caught up', async () => {
    readPollTick.mockResolvedValue(baseTick({ displayVersion: 5, instructionVersion: 1, instructionAck: 0 }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&displayAck=5'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayVersion: 5 });
  });

  it('carries a displayVersion BELOW the ack (a reset server row) on whatever wakes the poll', async () => {
    readPollTick.mockResolvedValue(baseTick({ displayVersion: 0, version: 2 }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&displayAck=7'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayVersion: 0 });
  });

  it('wakes when displayAck is ABOVE displayVersion (cross-boot re-pair: stale higher ack), and carries the lower version', async () => {
    // since=1 matches the tick's version and nothing else moved: only the
    // display mismatch can wake this. Before the fix (`>`), this held 30 s.
    readPollTick.mockResolvedValue(baseTick({ displayVersion: 2 }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&nfcAck=0&displayAck=5'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayVersion: 2 });
  });

  it('wakes when displayAck is above a row reset to displayVersion 0', async () => {
    readPollTick.mockResolvedValue(baseTick({ displayVersion: 0 }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&displayAck=5'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayVersion: 0 });
  });

  it('parses a garbled displayAck as 0 (never "caught up"), so a positive version wakes', async () => {
    readPollTick.mockResolvedValue(baseTick({ displayVersion: 1 }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&displayAck=1abc'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayVersion: 1 });
  });

  it('a MISSING displayAck (a board before 1.7.0) is never woken for display and gets no displayVersion', async () => {
    vi.useFakeTimers();
    try {
      readPollTick.mockResolvedValue(baseTick({ displayVersion: 4 }));
      const { GET } = await import('./route');
      let settled = false;
      const pending = GET(get('?since=1&nfcAck=0')).then((r) => { settled = true; return r; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(25_000);
      expect((await pending).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves displayVersion out of a woken body when the board sent no displayAck', async () => {
    readPollTick.mockResolvedValue(baseTick({ displayVersion: 4, instructionVersion: 1, instructionAck: 0 }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('displayVersion');
  });

  it('a caught-up board (displayAck = displayVersion) is not woken by the display', async () => {
    vi.useFakeTimers();
    try {
      readPollTick.mockResolvedValue(baseTick({ displayVersion: 4 }));
      const { GET } = await import('./route');
      let settled = false;
      const pending = GET(get('?since=1&displayAck=4')).then((r) => { settled = true; return r; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(25_000);
      expect((await pending).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });
});
