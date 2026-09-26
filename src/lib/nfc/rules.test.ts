import { describe, it, expect } from 'vitest';
import {
  DISK_ID_RE, decideTap, nfcWriteForPoll, shouldStoreWriteResult, NFC_WRITE_TTL_MS,
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
