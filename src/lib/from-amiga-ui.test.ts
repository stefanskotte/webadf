import { describe, it, expect } from 'vitest';
import { DISK_IMAGE_PATTERN } from '@/lib/archive/disk-image';
import type { UploadView } from '@/lib/amiga-uploads';
import {
  LIBRARY_EXT, STALL_MS, anyMoving, answerIsCurrent, canAddToLibrary, downloadName, emptyText, isStalled, trackProgress, tabTarget, cardUploadLine, clearBody, clearConfirm, clearable, libraryEligible, newestSeen, uploadChip, uploadErrorText,
} from './from-amiga-ui';

const row = (over: Partial<UploadView> = {}): UploadView => ({
  id: 'u', path: 'Lemmings.adf', sizeBytes: 901_120, status: 'stored', receivedBytes: 901_120, errorCode: null, deviceId: 'd',
  deviceName: 'Bench', createdAt: 1000, storedAt: 2000, expiresAt: 3000, libraryDiskId: null, libraryGameId: null,
  cursor: '2026-10-19T10:00:00.000001Z', ...over,
});

describe('from the Amiga: the rules the card shows', () => {
  it("offers Add to library for the library's extensions and sizes only", () => {
    expect(LIBRARY_EXT.source).toBe(DISK_IMAGE_PATTERN.source);
    expect(libraryEligible('Games/Lemmings.ADF', 901_120)).toBe(true);
    expect(libraryEligible('x.hfe', 2_000_000)).toBe(true);
    expect(libraryEligible('x.adf', 2_621_441)).toBe(false);
    expect(libraryEligible('x.dms', 4_000_000)).toBe(true);
    expect(libraryEligible('x.lha', 1000)).toBe(false);
    expect(libraryEligible('adf', 1000)).toBe(false);
    expect(libraryEligible('x.adf', 0)).toBe(false);
  });
  it('says how each row stands', () => {
    expect(uploadChip(row({ status: 'receiving', receivedBytes: 450_560 }))).toEqual({ kind: 'blue', label: 'Arriving 50 %', note: null });
    expect(uploadChip(row())).toEqual({ kind: 'green', label: 'Stored', note: null });
    expect(uploadChip(row({ status: 'failed', errorCode: 'crc' })).note).toMatch(/damaged on the way/);
    expect(uploadChip(row({ status: 'failed', errorCode: 'expired' })).note).toMatch(/24 hours/);
    expect(uploadChip(row({ status: 'failed', errorCode: 'zzz' })).note).toMatch(/did not arrive whole/);
    expect(uploadChip(row({ status: 'receiving', sizeBytes: 0, receivedBytes: 0 })).label).toBe('Arriving 0 %');
    expect(uploadChip(row({ status: 'receiving', receivedBytes: 901_120 })).label).toBe('Arriving 99 %');
  });
  it("the device card's line: files from the Amiga, or the update a Network board needs", () => {
    expect(cardUploadLine(2, '1.19.0+gabc', true)).toEqual({ text: '2 files from the Amiga', href: true });
    expect(cardUploadLine(1, '1.19.0+gabc', false)).toEqual({ text: '1 file from the Amiga', href: true });
    expect(cardUploadLine(undefined, '1.18.2', true)).toEqual({ text: 'Update to 1.19.0 to send files from the Amiga', href: false });
    expect(cardUploadLine(undefined, null, true)).toEqual({ text: 'Update to 1.19.0 to send files from the Amiga', href: false });
    expect(cardUploadLine(undefined, '1.18.2', false)).toBeNull();
    expect(cardUploadLine(0, '1.19.0+gabc', true)).toBeNull();
    expect(cardUploadLine(0, '1.19.0+gabc', false)).toBeNull();
  });
  it('Clear all: the count it names, and the newest row the person saw', () => {
    const rows = [
      row({ id: 'b', status: 'receiving', cursor: '2026-10-19T10:00:09.000009Z' }),
      row({ id: 'c', status: 'failed', cursor: '2026-10-19T10:00:07.000007Z' }),
      row({ id: 'a', cursor: '2026-10-19T10:00:05.000005Z' }),
    ];
    expect(clearable(rows)).toBe(2);
    expect(newestSeen(rows)).toBe('2026-10-19T10:00:09.000009Z');
    // newest created is first, but an older row stored later carries the greater cursor: that one is what was seen
    expect(newestSeen([row({ cursor: '2026-10-19T10:00:05.000005Z' }), row({ cursor: '2026-10-19T10:00:08.000001Z' })])).toBe('2026-10-19T10:00:08.000001Z');
    expect(newestSeen([])).toBeNull();
    expect(clearConfirm(1)).toBe('Clear 1 file from the Amiga?');
    expect(clearConfirm(3)).toBe('Clear 3 files from the Amiga?');
  });
  it('the Clear all request carries the newest cursor seen and the board filter, when there is one', () => {
    const rows = [row({ cursor: '2026-10-19T10:00:05.000005Z' }), row({ cursor: '2026-10-19T10:00:09.000009Z' })];
    expect(clearBody(rows, 'dev-1')).toEqual({ cursor: '2026-10-19T10:00:09.000009Z', board: 'dev-1' });
    expect(clearBody(rows, null)).toEqual({ cursor: '2026-10-19T10:00:09.000009Z' });
    expect('board' in clearBody(rows, null)!).toBe(false);
    expect(clearBody([], null)).toBeNull();
  });
  it('words for refusals', () => {
    expect(uploadErrorText('not_a_disk_image', 422)).toMatch(/not a disk image/i);
    expect(uploadErrorText('queue_full', 409)).toMatch(/queue/);
    expect(uploadErrorText('invalid', 400)).toMatch(/refresh/i);
    expect(uploadErrorText(undefined, 500)).toBe('The server answered 500.');
    expect(uploadErrorText('gone', 410)).toMatch(/no longer here/i);
    expect(uploadErrorText('invalid_body', 400)).toMatch(/not understood/i);
  });
  it('the saved name is the last part of the Amiga path, as the file route sends it', () => {
    expect(downloadName('Games/Lemmings.adf')).toBe('Lemmings.adf');
    expect(downloadName('DH0:Docs/Read Me.txt')).toBe('Read Me.txt');
    expect(downloadName('Work:')).toBe('file');
  });
  it('Tab stays inside the dialog: it wraps at both ends', () => {
    expect(tabTarget(0, 2, false)).toBeNull();   // the browser moves on by itself
    expect(tabTarget(1, 2, false)).toBe(0);      // last -> first
    expect(tabTarget(0, 2, true)).toBe(1);       // first, Shift+Tab -> last
    expect(tabTarget(-1, 2, false)).toBe(0);     // focus outside -> in
    expect(tabTarget(-1, 2, true)).toBe(1);
    expect(tabTarget(0, 0, false)).toBeNull();
  });
});

describe('a stalled upload', () => {
  const moving = row({ id: 'm', status: 'receiving', receivedBytes: 450_560 });
  it('is a receiving row whose bytes have not moved for two minutes', () => {
    let seen = trackProgress({}, [moving], 1_000);
    expect(isStalled(moving, seen, 1_000 + STALL_MS - 1)).toBe(false);
    expect(isStalled(moving, seen, 1_000 + STALL_MS)).toBe(true);
    // a poll that finds the same bytes keeps the old clock; one that finds more restarts it
    seen = trackProgress(seen, [moving], 60_000);
    expect(isStalled(moving, seen, 1_000 + STALL_MS)).toBe(true);
    const more = { ...moving, receivedBytes: 466_944 };
    seen = trackProgress(seen, [more], 130_000);
    expect(isStalled(more, seen, 130_000 + STALL_MS - 1)).toBe(false);
    expect(isStalled(more, seen, 130_000 + STALL_MS)).toBe(true);
  });
  it('never applies to a row that is not receiving or has not been seen', () => {
    const seen = trackProgress({}, [moving], 0);
    expect(isStalled(row(), seen, 10 * STALL_MS)).toBe(false);
    expect(isStalled(moving, {}, 10 * STALL_MS)).toBe(false);
    expect(trackProgress(seen, [], 5)).toEqual({});   // a row that left the list is forgotten
  });
  it('reads Stopped at N % with the way out, and the list polls fast only while some row is moving', () => {
    expect(uploadChip(moving, true)).toEqual({ kind: 'amber', label: 'Stopped at 50 %', note: 'send it again from the Amiga to continue' });
    expect(uploadChip(moving, false).label).toBe('Arriving 50 %');
    const other = row({ id: 'o', status: 'receiving', receivedBytes: 1 });
    const seen = trackProgress({}, [moving, other], 0);
    const later = STALL_MS;
    expect(anyMoving([moving, other], seen, later)).toBe(false);
    expect(anyMoving([moving, other, row()], seen, later)).toBe(false);
    const seen2 = trackProgress(seen, [moving, { ...other, receivedBytes: 99 }], later - 1);
    expect(anyMoving([moving, { ...other, receivedBytes: 99 }], seen2, later)).toBe(true);
    expect(anyMoving([], {}, 0)).toBe(false);
  });
});

describe('the card words that depend on the boards and the library', () => {
  it('the empty list says what is missing when no board can send', () => {
    expect(emptyText([{ canUpload: true }])).toMatch(/Drop files on Transfer's window, or type Transfer SEND/);
    expect(emptyText([{ canUpload: false }, { canUpload: true }])).toMatch(/Drop files on Transfer/);
    const no = /No board can send from the Amiga yet: update to 1\.19\.0 and use Network \(PaulaNET\) mode/;
    expect(emptyText([{ canUpload: false }])).toMatch(no);
    expect(emptyText([])).toMatch(no);
  });
  it('Add to library is offered while the disk is not in the library, also after its disk was deleted', () => {
    expect(canAddToLibrary(row())).toBe(true);
    expect(canAddToLibrary(row({ libraryDiskId: 'd1', libraryGameId: 'g1' }))).toBe(false);
    expect(canAddToLibrary(row({ libraryDiskId: 'd1', libraryGameId: null }))).toBe(true);
    expect(canAddToLibrary(row({ path: 'x.txt' }))).toBe(false);
    expect(canAddToLibrary(row({ status: 'receiving' }))).toBe(false);
  });
  it('an answer older than the last change is dropped', () => {
    expect(answerIsCurrent(3, 3)).toBe(true);
    expect(answerIsCurrent(3, 4)).toBe(false);
  });
});
