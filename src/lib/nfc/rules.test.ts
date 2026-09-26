import { describe, it, expect } from 'vitest';
import {
  DISK_ID_RE, decideTap, nfcWriteForPoll, shouldStoreWriteResult, NFC_WRITE_TTL_MS,
  chooseNfcDevice, nfcWriteStatus, formatTagUid, writeFailureText,
} from './rules';

const ID = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const ID2 = 'ffffffff-0000-5000-9000-000000000000';
const t = (ms: number) => new Date(1_790_000_000_000 + ms);

describe('DISK_ID_RE', () => {
  it('accepts a stableId', () => expect(DISK_ID_RE.test(ID)).toBe(true));
  it.each(['', ID.toUpperCase(), ID.slice(1), `${ID}x`, 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    "'; drop table disks; --"])('refuses %j', (s) => expect(DISK_ID_RE.test(s)).toBe(false));
});

describe('decideTap', () => {
  it('mounts a different disk', () =>
    expect(decideTap({ desiredDiskId: ID2, lastTapAt: null }, ID, t(0))).toBe('mount'));
  it('mounts into an empty drive', () =>
    expect(decideTap({ desiredDiskId: null, lastTapAt: t(0) }, ID, t(5000))).toBe('mount'));
  it('is a no-op for the disk already desired', () =>
    expect(decideTap({ desiredDiskId: ID, lastTapAt: null }, ID, t(0))).toBe('already'));
  it('ignores a tap within 1 s of the last', () =>
    expect(decideTap({ desiredDiskId: null, lastTapAt: t(0) }, ID, t(999))).toBe('ignored'));
  it('accepts a tap exactly 1 s later', () =>
    expect(decideTap({ desiredDiskId: null, lastTapAt: t(0) }, ID, t(1000))).toBe('mount'));
});

describe('nfcWriteForPoll', () => {
  const live = { nfcWriteSeq: 3, nfcWriteDiskId: ID, nfcWriteExpiresAt: t(NFC_WRITE_TTL_MS), nfcWriteResultSeq: null };
  it('offers a live request the board has not acked', () =>
    expect(nfcWriteForPoll(live, 2, t(0))).toEqual({ seq: 3, diskId: ID }));
  it('says nothing once the board has acked this seq', () =>
    expect(nfcWriteForPoll(live, 3, t(0))).toBeNull());
  it('says nothing to a board AHEAD of the server (restore): no wake loop', () =>
    expect(nfcWriteForPoll(live, 9, t(0))).toBeNull());
  it('turns an expired request into a disarm', () =>
    expect(nfcWriteForPoll(live, 2, t(NFC_WRITE_TTL_MS + 1))).toEqual({ seq: 3, diskId: null }));
  it('turns a cancelled request (no disk) into a disarm', () =>
    expect(nfcWriteForPoll({ ...live, nfcWriteDiskId: null }, 2, t(0))).toEqual({ seq: 3, diskId: null }));
  it('turns an answered request into a disarm', () =>
    expect(nfcWriteForPoll({ ...live, nfcWriteResultSeq: 3 }, 2, t(0))).toEqual({ seq: 3, diskId: null }));
  it('says nothing when there has never been a request', () =>
    expect(nfcWriteForPoll({ ...live, nfcWriteSeq: 0, nfcWriteDiskId: null }, 0, t(0))).toBeNull());
});

describe('shouldStoreWriteResult', () => {
  it('stores the first result for the current seq', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 3, nfcWriteResultSeq: null }, 3)).toBe(true));
  it('refuses a stale seq', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 4, nfcWriteResultSeq: null }, 3)).toBe(false));
  it('refuses a duplicate', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 3, nfcWriteResultSeq: 3 }, 3)).toBe(false));
  it('refuses a seq from the future', () =>
    expect(shouldStoreWriteResult({ nfcWriteSeq: 3, nfcWriteResultSeq: null }, 4)).toBe(false));
});

describe('chooseNfcDevice', () => {
  const present = (id: string) => ({ id, name: `Board ${id}`, nfcReader: 'present' as string | null });
  const absent = (id: string) => ({ id, name: `Board ${id}`, nfcReader: 'absent' as string | null });
  const older = (id: string) => ({ id, name: `Board ${id}`, nfcReader: null as string | null });

  it('picks the only board with a reader when none is named', () => {
    expect(chooseNfcDevice([absent('a'), present('b'), older('c')])).toEqual({ ok: true, device: present('b') });
  });
  it('refuses with no_reader when no board has one', () => {
    expect(chooseNfcDevice([absent('a'), older('c')])).toEqual({ ok: false, error: 'no_reader' });
    expect(chooseNfcDevice([])).toEqual({ ok: false, error: 'no_reader' });
  });
  it('asks for a board when more than one has a reader', () => {
    expect(chooseNfcDevice([present('a'), present('b')])).toEqual({ ok: false, error: 'device_required' });
  });
  it('takes a named board that has a reader', () => {
    expect(chooseNfcDevice([present('a'), present('b')], 'b')).toEqual({ ok: true, device: present('b') });
  });
  it('refuses a named board without a present reader as no_reader', () => {
    expect(chooseNfcDevice([absent('a'), present('b')], 'a')).toEqual({ ok: false, error: 'no_reader' });
    expect(chooseNfcDevice([older('a')], 'a')).toEqual({ ok: false, error: 'no_reader' });
  });
  it('answers not_found for a board outside the list (foreign or unknown alike)', () => {
    expect(chooseNfcDevice([present('a')], 'zzz')).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('nfcWriteStatus', () => {
  const row = (over: Partial<Parameters<typeof nfcWriteStatus>[0]> = {}) => ({
    nfcWriteSeq: 5, nfcWriteExpiresAt: t(NFC_WRITE_TTL_MS),
    nfcWriteResultSeq: null as number | null, nfcWriteResult: null as string | null,
    nfcWriteResultUid: null as string | null, ...over,
  });

  it('is waiting while the request is current and unexpired', () => {
    expect(nfcWriteStatus(row(), 5, t(0))).toEqual({ state: 'waiting' });
    expect(nfcWriteStatus(row(), 5, t(NFC_WRITE_TTL_MS))).toEqual({ state: 'waiting' });
  });
  it('is ok with the uid once the board answered ok for this seq', () => {
    expect(nfcWriteStatus(row({ nfcWriteResultSeq: 5, nfcWriteResult: 'ok', nfcWriteResultUid: '2419B601' }), 5, t(0)))
      .toEqual({ state: 'ok', uid: '2419B601' });
  });
  it('is failed with the reason once the board answered a failure', () => {
    expect(nfcWriteStatus(row({ nfcWriteResultSeq: 5, nfcWriteResult: 'locked', nfcWriteResultUid: '2419B601' }), 5, t(0)))
      .toEqual({ state: 'failed', reason: 'locked', uid: '2419B601' });
  });
  it('still reports an answer that landed after the expiry', () => {
    expect(nfcWriteStatus(row({ nfcWriteResultSeq: 5, nfcWriteResult: 'ok', nfcWriteResultUid: 'AA' }), 5,
      t(NFC_WRITE_TTL_MS + 5000))).toEqual({ state: 'ok', uid: 'AA' });
  });
  it('is superseded when a newer request moved the cursor and no answer exists for this seq', () => {
    expect(nfcWriteStatus(row({ nfcWriteSeq: 6 }), 5, t(0))).toEqual({ state: 'superseded' });
    // A newer request's own answer is not ours.
    expect(nfcWriteStatus(row({ nfcWriteSeq: 6, nfcWriteResultSeq: 6, nfcWriteResult: 'ok' }), 5, t(0)))
      .toEqual({ state: 'superseded' });
  });
  it('keeps an answer for this seq even after a cancel moved the cursor past it', () => {
    expect(nfcWriteStatus(row({ nfcWriteSeq: 6, nfcWriteResultSeq: 5, nfcWriteResult: 'ok', nfcWriteResultUid: 'AA' }), 5, t(0)))
      .toEqual({ state: 'ok', uid: 'AA' });
  });
  it('is expired after the expiry with no answer', () => {
    expect(nfcWriteStatus(row(), 5, t(NFC_WRITE_TTL_MS + 1))).toEqual({ state: 'expired' });
    expect(nfcWriteStatus(row({ nfcWriteExpiresAt: null }), 5, t(0))).toEqual({ state: 'expired' });
  });
  it('knows nothing of a seq that was never issued', () => {
    expect(nfcWriteStatus(row(), 6, t(0))).toBeNull();
  });
});

describe('formatTagUid', () => {
  it('spaces the board\'s contiguous hex into pairs', () => {
    expect(formatTagUid('2419B601')).toBe('24 19 B6 01');
  });
  it('accepts colon-separated and lower-case uids', () => {
    expect(formatTagUid('24:19:b6:01')).toBe('24 19 B6 01');
  });
  it('shows nothing for an empty uid or the firmware\'s "none"', () => {
    expect(formatTagUid(null)).toBeNull();
    expect(formatTagUid('')).toBeNull();
    expect(formatTagUid('none')).toBeNull();
  });
});

describe('writeFailureText', () => {
  it.each([
    ['locked', 'Locked tag — it cannot be written.'],
    ['moved', 'Tag moved — hold it still until the board confirms.'],
    ['verify', 'Verify failed — the tag read back differently.'],
  ])('%s', (reason, text) => { expect(writeFailureText(reason)).toBe(text); });
  it('names an unknown reason rather than hiding it', () => {
    expect(writeFailureText('bad data')).toBe('Write failed (bad data).');
  });
});
