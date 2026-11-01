import { describe, it, expect } from 'vitest';
import {
  barOf, canCancel, cardShown, commonDrawer, confirmWords, failureList, isClean, jobLine, jobNow, jobTitle, leftWords, panelLift,
  pillWords, resultWords, sizeWords, timeLeft, type JobView, type Sample,
} from './job-view';

const KB = 1024;
const MB = 1024 * 1024;
type W = JobView['writes'][number];
const w = (o: Partial<W> = {}): W => ({ kind: 'delete', label: 'Workbench:Old', to: null, status: 'waiting', removed: 0, reason: null, entry: null, quiet: false, ...o });
const job = (o: Partial<JobView> = {}): JobView => ({
  id: 'j1', kind: 'copy', direction: 'to', board: 'A500', from: null, place: 'Work:Tools', writeKind: null,
  total: 12, done: 3, failed: [], waiting: 9, skipped: 0, writes: [], offline: null, arrived: [],
  cancelled: 0, cancel: null, bytes: { total: Math.round(9.8 * MB), done: Math.round(2.4 * MB) }, current: 'Work:Tools/Disk1.adf', running: true,
  startedAt: '2026-11-01T10:00:00.000Z', finishedAt: null, ...o,
});
const done = (o: Partial<JobView> = {}) => job({ running: false, waiting: 0, current: null, finishedAt: '2026-11-01T10:01:00.000Z', ...o });

describe('jobTitle (spec §3)', () => {
  it('says what and where', () => {
    expect(jobTitle(job())).toBe('Copying to A500 · Work:Tools');
    expect(jobTitle(job({ kind: 'move' }))).toBe('Moving to A500 · Work:Tools');
    expect(jobTitle(job({ from: 'A1200' }))).toBe('Copying from A1200 to A500 · Work:Tools');
    expect(jobTitle(job({ direction: 'from', place: 'STASH:' }))).toBe('Copying from A500 to STASH:');
    expect(jobTitle(job({ kind: 'send', total: 3, place: null }))).toBe('Sending 3 files to A500');
    expect(jobTitle(job({ kind: 'send', total: 1, place: null }))).toBe('Sending 1 file to A500');
  });
  it('a write job: its one object, or how many', () => {
    expect(jobTitle(job({ kind: 'write', writeKind: 'delete', total: 0, writes: [w(), w({ label: 'Workbench:Old.info', quiet: true })] })))
      .toBe('Deleting Workbench:Old on A500');
    expect(jobTitle(job({ kind: 'write', writeKind: 'delete', total: 0, writes: [w(), w({ label: 'b' }), w({ label: 'c' })] }))).toBe('Deleting 3 items on A500');
    expect(jobTitle(job({ kind: 'write', writeKind: null, total: 0, writes: [w(), w({ kind: 'rename', label: 'b' })] }))).toBe('Changing 2 items on A500');
  });
});

describe('jobLine, sizeWords, leftWords', () => {
  it('files, bytes and the time left', () => {
    expect(jobLine(job(), 70)).toBe('3 of 12 files · 2.4 of 9.8 MB · about 1 min left');
    expect(jobLine(job(), null)).toBe('3 of 12 files · 2.4 of 9.8 MB');
  });
  it('an offline board: waiting, and no estimate', () => {
    expect(jobLine(job({ offline: 'A500' }), 70)).toBe('3 of 12 files · 2.4 of 9.8 MB · Waiting for A500 (offline)');
  });
  it('under a megabyte in KB', () => {
    expect(sizeWords(12 * KB, 820 * KB)).toBe('12 of 820 KB');
    expect(sizeWords(Math.round(2.4 * MB), Math.round(9.8 * MB))).toBe('2.4 of 9.8 MB');
  });
  it('time left in words', () => {
    expect(leftWords(8)).toBe('less than a minute left');
    expect(leftWords(70)).toBe('about 1 min left');
    expect(leftWords(200)).toBe('about 3 min left');
  });
  // Review Focus 1: only empty files -- by files, never "of 0 KB" or NaN.
  it('a job of empty files says no size and its bar goes by files', () => {
    const empty = job({ total: 2, done: 0, waiting: 2, bytes: { total: 0, done: 0 } });
    expect(jobLine(empty, null)).toBe('0 of 2 files');
    expect(barOf(empty)).toEqual({ value: 0, byBytes: false });
    expect(barOf({ ...empty, waiting: 1 })).toEqual({ value: 50, byBytes: false });
  });
  it('one file, one item', () => {
    expect(jobLine(job({ total: 1, done: 0, waiting: 1, bytes: { total: 4, done: 0 } }), null)).toBe('0 of 1 file · 0 of 1 KB');
    expect(jobLine(job({ kind: 'write', total: 0, bytes: null, writes: [w({ status: 'running' })] }), null)).toBe('0 of 1 item');
  });
});

describe('barOf', () => {
  it('by bytes where known, by items otherwise', () => {
    expect(barOf(job())).toEqual({ value: 24, byBytes: true });
    expect(barOf(job({ kind: 'write', total: 0, bytes: null, writes: [w({ status: 'done' }), w({ status: 'running' })] }))).toEqual({ value: 50, byBytes: false });
  });
});

describe('timeLeft (spec §3: after 10 s of progress, the last 30 s of bytes)', () => {
  const t0 = 1_000_000;
  const every2s = (n: number): Sample[] => Array.from({ length: n }, (_, k) => ({ at: t0 + k * 2000, done: k * 100_000 }));
  const j = job({ bytes: { total: 1_000_000, done: 600_000 } });
  it('a rolling estimate once warm', () => {
    expect(timeLeft(every2s(7), j, t0 + 12_000)).toBe(8);
  });
  it('not before 10 s of progress', () => {
    expect(timeLeft(every2s(6), j, t0 + 11_999)).toBeNull();
    expect(timeLeft([{ at: t0, done: 0 }, { at: t0 + 2000, done: 0 }], j, t0 + 20_000)).toBeNull();
  });
  it('samples older than 30 s do not count', () => {
    expect(timeLeft([{ at: t0 - 40_000, done: 0 }, ...every2s(7)], j, t0 + 12_000)).toBe(8);
  });
  it('none while the board is offline, nor once finished', () => {
    expect(timeLeft(every2s(7), { ...j, offline: 'A500' }, t0 + 12_000)).toBeNull();
    expect(timeLeft(every2s(7), { ...j, running: false }, t0 + 12_000)).toBeNull();
  });
});

describe('jobNow', () => {
  it('the file moving now, else the write running, else nothing', () => {
    expect(jobNow(job())).toBe('Work:Tools/Disk1.adf');
    expect(jobNow(job({ kind: 'write', total: 0, current: null, writes: [w({ label: 'Work:Big', status: 'running', removed: 50 })] })))
      .toBe('Deleting Work:Big on A500… removed 50 so far');
    expect(jobNow(job({ current: null }))).toBeNull();
    expect(jobNow(done())).toBeNull();
  });
});

describe('resultWords (today\'s finished line, and Cancel\'s)', () => {
  it('a finished copy says what jobStatus says', () => {
    expect(resultWords(done({ done: 12 }))).toBe('Copied 12 to A500');
    expect(resultWords(done({ done: 11, skipped: 1 }))).toBe('Copied 11 to A500, skipped 1 (already there)');
  });
  it('cancelled: how far it got, and for a move where the rest is', () => {
    expect(resultWords(done({ done: 5, cancelled: 7, cancel: { move: false, source: null } }))).toBe('Cancelled: 5 of 12 copied');
    expect(resultWords(done({ kind: 'move', done: 5, cancelled: 7, cancel: { move: true, source: 'STASH:/Games' } })))
      .toBe('Cancelled: 5 of 12 moved; the rest is still in STASH:/Games');
    expect(resultWords(done({ kind: 'write', total: 0, bytes: null, cancelled: 2, cancel: { move: false, source: null },
      writes: [w({ status: 'done' }), w({ status: 'failed', reason: 'cancelled' }), w({ status: 'failed', reason: 'cancelled' })] }))).toBe('Cancelled: 1 of 3 done');
  });
  it('a part cancelled elsewhere (a Queue Delete) is said apart', () => {
    expect(resultWords(done({ total: 3, done: 2, cancelled: 1 }))).toBe('Copied 2 to A500 · 1 cancelled');
  });
  it('plain sends', () => {
    expect(resultWords(done({ kind: 'send', total: 3, done: 3, place: null }))).toBe('Sent 3 files to A500');
    expect(resultWords(done({ kind: 'send', total: 3, done: 2, place: null, failed: [{ name: 'x.lha', reason: 'Transfer is not running' }] })))
      .toBe('Sent 2 files to A500, 1 failed: x.lha: Transfer is not running');
  });
});

describe('failureList', () => {
  it('the first five, then how many more', () => {
    const failed = Array.from({ length: 7 }, (_, k) => ({ name: `f${k}`, reason: 'r' }));
    expect(failureList(done({ failed }))).toEqual(['f0: r', 'f1: r', 'f2: r', 'f3: r', 'f4: r', 'and 2 more']);
    expect(failureList(done({ failed: failed.slice(0, 2) }))).toEqual(['f0: r', 'f1: r']);
  });
});

describe('isClean and cardShown (spec §3: a clean finish fades after 6 s, a failure stays)', () => {
  const now = 100_000;
  it('a clean finish shows for 6 s', () => {
    expect(cardShown(done(), { finishedSeenAt: now - 5_000, dismissed: false, now })).toBe(true);
    expect(cardShown(done(), { finishedSeenAt: now - 7_000, dismissed: false, now })).toBe(false);
    expect(cardShown(done(), { finishedSeenAt: null, dismissed: false, now })).toBe(true);
  });
  it('a failure, a cancel or a kept drawer stays until closed', () => {
    for (const j of [done({ failed: [{ name: 'a', reason: 'r' }] }), done({ cancel: { move: false, source: null } }), done({ cancelled: 1 }),
      done({ writes: [w({ status: 'done', kept: true })] }), done({ writes: [w({ status: 'failed', reason: 'In use on the Amiga' })] })]) {
      expect(isClean(j)).toBe(false);
      expect(cardShown(j, { finishedSeenAt: now - 60_000, dismissed: false, now })).toBe(true);
      expect(cardShown(j, { finishedSeenAt: now - 60_000, dismissed: true, now })).toBe(false);
    }
  });
  it('a running card shows whatever was remembered', () => {
    expect(cardShown(job(), { finishedSeenAt: null, dismissed: true, now })).toBe(true);
  });
});

describe('pillWords (spec §3: bytes over all running jobs)', () => {
  it('one job, two jobs, none running', () => {
    expect(pillWords([job()])).toBe('1 job · 24 %');
    // Review Focus 2: two at once, summed by bytes.
    expect(pillWords([job({ bytes: { total: 1000, done: 200 } }), job({ id: 'j2', bytes: { total: 3000, done: 1000 } })])).toBe('2 jobs · 30 %');
    expect(pillWords([done(), done({ id: 'j2' })])).toBe('2 finished');
    expect(pillWords([done()])).toBe('1 finished');
  });
});

describe('canCancel and confirmWords (spec §5, §6)', () => {
  it('only a running job not cancelled yet', () => {
    expect(canCancel(job())).toBe(true);
    expect(canCancel(job({ cancel: { move: false, source: null } }))).toBe(false);
    expect(canCancel(done())).toBe(false);
  });
  it('asks first, in the job\'s own noun', () => {
    expect(confirmWords(job())).toBe('Cancel the rest of this copy? What has arrived stays.');
    expect(confirmWords(job({ kind: 'move' }))).toBe('Cancel the rest of this move? What has arrived stays.');
    expect(confirmWords(job({ kind: 'send' }))).toBe('Cancel the rest of this send? What has arrived stays.');
    expect(confirmWords(job({ kind: 'write' }))).toBe('Cancel the rest of these changes? What is done stays.');
  });
});

describe('commonDrawer', () => {
  it('the drawer the paths share', () => {
    expect(commonDrawer(['Workbench:Monkey/Disk1/a', 'Workbench:Monkey/Disk2/b'])).toBe('Workbench:Monkey');
    expect(commonDrawer(['Work:Tools/x'])).toBe('Work:Tools');
    expect(commonDrawer(['STASH:/Pack/a', 'STASH:/Pack/b'])).toBe('STASH:/Pack');
    expect(commonDrawer(['STASH:/a.txt', 'STASH:/Pack/b'])).toBe('STASH:');
    expect(commonDrawer(['work:tools/a', 'Work:Tools/b'])).toBe('work:tools');
    expect(commonDrawer([])).toBeNull();
    expect(commonDrawer(['Work:a', 'DH1:b'])).toBeNull();
  });
});

describe('panelLift', () => {
  it('above the lowest anchor on screen, else nothing', () => {
    expect(panelLift([], 800)).toBe(0);
    expect(panelLift([700], 800)).toBe(108);
    expect(panelLift([0, 650], 800)).toBe(158);
    expect(panelLift([900], 800)).toBe(0);
  });
});
