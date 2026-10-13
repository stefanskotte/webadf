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
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

const requireDevice = vi.fn<(r: Request) => Promise<{ deviceId: string; orgId: string }>>(
  async () => ({ deviceId: 'dev-1', orgId: 'org-1' }),
);
const touchLastSeen = vi.fn(async () => undefined);
const readPollTick = vi.fn<() => Promise<PollTick | null>>();
const readDesired = vi.fn<() => Promise<DesiredState | null>>(
  async () => ({ version: 1, desired: null }),
);
const readFirmwareInstruction = vi.fn(async () => null);
const markNetNextSent = vi.fn<(deviceId: string, v: number) => Promise<void>>(async () => undefined);

vi.mock('@/lib/device-auth', () => ({
  requireDevice: (r: Request) => requireDevice(r),
  deviceAuthResponse: () => null,
}));
vi.mock('@/lib/mount', () => ({
  touchLastSeen: () => touchLastSeen(),
  readPollTick: () => readPollTick(),
  readDesired: () => readDesired(),
  readFirmwareInstruction: () => readFirmwareInstruction(),
  markNetNextSent: (deviceId: string, v: number) => markNetNextSent(deviceId, v),
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
  version: 1, instructionVersion: 0, instructionAck: 0, nfcWriteSeq: 0, displayVersion: 0, secondDriveVersion: 0, secondDrive: 'off',
  secondDriveReported: null, secondDriveAppliedVersion: null, netNextSentVersion: null, ...over,
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

  // Network mode (spec 2026-10-12 §2, pre-flight I2). `applied`: the board has reported running Network for
  // the current setting version; `chosen`: the user picked Network, the board has not reported it yet.
  const applied = { secondDrive: 'net' as const, secondDriveVersion: 3, secondDriveReported: 'net' as const,
    secondDriveAppliedVersion: 3 };
  const chosen = { secondDrive: 'net' as const, secondDriveVersion: 3, secondDriveReported: 'df1' as const,
    secondDriveAppliedVersion: 2 };

  it('Network mode, applied: next is the PaulaNET driver disk, not the next disk of the set', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...applied,
      netNextSentVersion: 3 }));
    readDesired.mockResolvedValue({ version: 1, desired: desiredDisk });
    readNextForPoll.mockResolvedValue({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
    const { GET } = await import('./route');
    const body = await (await GET(get('?since=1&driveAck=3'))).json();
    expect(body.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
    expect(readNextForPoll).not.toHaveBeenCalled();
    expect(markNetNextSent).not.toHaveBeenCalled();   // already sent at this version
  });

  it('Network mode, applied, with nothing desired: next is still the driver disk (ruling 6)', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...applied }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    const body = await (await GET(get('?since=1&driveAck=3'))).json();
    expect(body.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
    expect(readNextForPoll).not.toHaveBeenCalled();
  });

  it('Network mode chosen but not yet reported by the board: next is as in Next disk mode (I2)', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...chosen }));
    readDesired.mockResolvedValue({ version: 1, desired: desiredDisk });
    readNextForPoll.mockResolvedValue({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
    const { GET } = await import('./route');
    const body = await (await GET(get('?since=1&driveAck=2'))).json();
    expect(body.next).toEqual({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
    expect(body.secondDrive).toEqual({ seq: 3, mode: 'net' });
    expect(markNetNextSent).not.toHaveBeenCalled();
  });

  it('Network mode chosen but not yet reported, nothing desired: no next at all (I2)', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...chosen }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    expect(await (await GET(get('?since=1&driveAck=2'))).json()).not.toHaveProperty('next');
  });

  // Final review m1: a second save of 'net' while the board already runs Network bumps the version. Until the
  // board reports the new one, the poll used the non-Network rule and sent next: null (or the set's next),
  // ejecting the driver disk. The board is in Network either way, so the driver disk stays `next`; the wake
  // cursor is still keyed on the applied version.
  it('Network saved again while the board already reports Network at an older version: still the driver disk (m1)',
    async () => {
      readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...applied,
        secondDriveVersion: 4, secondDriveAppliedVersion: 3, netNextSentVersion: 3 }));
      readDesired.mockResolvedValue({ version: 1, desired: desiredDisk });
      readNextForPoll.mockResolvedValue({ diskId: 'd2', sha256: 'b'.repeat(64), diskNo: 2 });
      const { GET } = await import('./route');
      const body = await (await GET(get('?since=1&driveAck=3'))).json();
      expect(body.secondDrive).toEqual({ seq: 4, mode: 'net' });
      expect(body.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
      expect(readNextForPoll).not.toHaveBeenCalled();
      expect(markNetNextSent).not.toHaveBeenCalled();   // the cursor waits for the applied version
    });

  it('...and with nothing desired: the driver disk, never next: null (m1)', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, ...applied,
      secondDriveVersion: 4, secondDriveAppliedVersion: 3 }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    const body = await (await GET(get('?since=1&driveAck=3'))).json();
    expect(body.next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
  });

  it('Network saved again, board on the older version: no driver-disk wake of its own (holds)', async () => {
    vi.useFakeTimers();
    try {
      readPollTick.mockResolvedValue(baseTick({ ...applied, secondDriveVersion: 4, secondDriveAppliedVersion: 3,
        netNextSentVersion: 3 }));
      const { GET } = await import('./route');
      const p = GET(get('?since=1&driveAck=4'));
      await vi.advanceTimersByTimeAsync(26_000);
      expect((await p).status).toBe(204);
      expect(markNetNextSent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Network applied and never sent: wakes on its own once, carries the driver disk, records the cursor', async () => {
    // since and driveAck are both caught up: only the driver disk's cursor can wake this poll.
    readPollTick.mockResolvedValue(baseTick({ ...applied, netNextSentVersion: 2 }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&driveAck=3'));
    expect(res.status).toBe(200);
    expect((await res.json()).next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
    expect(markNetNextSent).toHaveBeenCalledWith('dev-1', 3);
  });

  it('after a status report re-armed the cursor (null): the next poll wakes and sends the driver disk again', async () => {
    readPollTick.mockResolvedValue(baseTick({ ...applied, netNextSentVersion: null }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&driveAck=3'));
    expect(res.status).toBe(200);
    expect((await res.json()).next).toEqual({ diskId: 'paulanet', sha256: PAULANET_DISK_SHA256, diskNo: 1 });
    expect(markNetNextSent).toHaveBeenCalledWith('dev-1', 3);
  });

  it('Network applied and already sent at this version: holds (a cursor, not a flag)', async () => {
    vi.useFakeTimers();
    try {
      readPollTick.mockResolvedValue(baseTick({ ...applied, netNextSentVersion: 3 }));
      const { GET } = await import('./route');
      const p = GET(get('?since=1&driveAck=3'));
      await vi.advanceTimersByTimeAsync(26_000);
      expect((await p).status).toBe(204);
      expect(markNetNextSent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Network chosen, not yet applied: no wake for the driver disk (holds)', async () => {
    vi.useFakeTimers();
    try {
      readPollTick.mockResolvedValue(baseTick({ ...chosen, secondDriveAppliedVersion: 3 }));   // acked, still df1
      const { GET } = await import('./route');
      const p = GET(get('?since=1&driveAck=3'));
      await vi.advanceTimersByTimeAsync(26_000);
      expect((await p).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Next disk mode with nothing desired: still no next (unchanged)', async () => {
    readPollTick.mockResolvedValue(baseTick({ instructionVersion: 1, instructionAck: 0, secondDrive: 'df1',
      secondDriveReported: 'df1', secondDriveAppliedVersion: 0 }));
    readDesired.mockResolvedValue({ version: 1, desired: null });
    const { GET } = await import('./route');
    expect(await (await GET(get('?since=1&driveAck=0'))).json()).not.toHaveProperty('next');
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

describe('GET /api/device/poll -- driveAck and secondDrive', () => {
  it('wakes on a driveAck mismatch and carries secondDrive inline', async () => {
    readPollTick.mockResolvedValue(baseTick({ secondDriveVersion: 2, secondDrive: 'df1' }));
    const { GET } = await import('./route');
    const res = await GET(get('?since=1&driveAck=1'));
    expect(res.status).toBe(200);
    expect((await res.json()).secondDrive).toEqual({ seq: 2, mode: 'df1' });
  });
  it('never wakes or sends secondDrive to a board without driveAck', async () => {
    readPollTick.mockResolvedValue(baseTick({ version: 2, secondDriveVersion: 5, secondDrive: 'df1' }));
    const { GET } = await import('./route');
    const body = await (await GET(get('?since=1'))).json();
    expect(body.secondDrive).toBeUndefined();
  });
  it('does not wake when driveAck matches, and a lone since-caught-up poll holds (204)', async () => {
    vi.useFakeTimers();
    try {
      readPollTick.mockResolvedValue(baseTick({ secondDriveVersion: 2, secondDrive: 'df1' }));
      const { GET } = await import('./route');
      const p = GET(get('?since=1&driveAck=2'));
      await vi.advanceTimersByTimeAsync(26_000);
      expect((await p).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });
});
