import { describe, it, expect } from 'vitest';
import {
  askingAbout, barOf, canCancel, cardShown, commonDrawer, confirmWords, failureList, isClean, jobLine, jobNow, jobTitle, leftWords, panelLift,
  addToFit, pillWords, QUEUE_JOB, resultWords, sizeWords, timeLeft, type Fit, type JobView, type Sample,
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
  it('a job of quiet drawers alone names the place they go, and counts them (M-3)', () => {
    const quiet = [w({ kind: 'mkdir', label: 'Work:Monkey/Disk 1', quiet: true, status: 'done' }), w({ kind: 'mkdir', label: 'Work:Monkey/Disk 2', quiet: true })];
    const j = job({ kind: 'write', place: 'Work:Monkey', total: 0, waiting: 0, bytes: null, writes: quiet });
    expect(jobTitle(j)).toBe('Changing the disks of A500 · Work:Monkey');
    expect(jobTitle({ ...j, place: null })).toBe('Changing the disks of A500');
    expect(jobLine(j, null)).toBe('1 of 2 items');
    expect(barOf(j)).toEqual({ value: 50, byBytes: false });
    expect(resultWords(done({ kind: 'write', place: 'Work:Monkey', total: 0, bytes: null, cancel: { move: false, source: null },
      writes: [quiet[0], w({ ...quiet[1], status: 'failed', reason: 'cancelled' })] }))).toBe('Cancelled: 1 of 2 done');
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
      .toBe('Cancelled: 5 of 12 copied; the rest is still in STASH:/Games');
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
  it('a cancelled move says copied: a file whose original was not removed still counts', () => {
    expect(resultWords(done({ kind: 'move', total: 8, done: 2, cancelled: 6, cancel: { move: true, source: 'STASH:/x' } })))
      .toBe('Cancelled: 2 of 8 copied; the rest is still in STASH:/x');
  });
  it('a Queue send says Cancel takes every file waiting for that board', () => {
    const q = (waiting: number) => job({ id: `${QUEUE_JOB}d1:1`, kind: 'send', place: null, total: waiting, waiting });
    expect(confirmWords(q(12))).toBe('Cancels all 12 files waiting for A500. What has arrived stays.');
    expect(confirmWords(q(1))).toBe('Cancels the 1 file waiting for A500. What has arrived stays.');
    expect(confirmWords(job({ kind: 'send' }))).toBe('Cancel the rest of this send? What has arrived stays.');
  });
  it('a write job whose drawer delete already runs says that drawer finishes first (spec §6 limit)', () => {
    const running = job({ kind: 'write', writes: [w({ status: 'running' }), w({ label: 'Work:B' })] });
    expect(confirmWords(running)).toBe('Cancel the rest of these changes? A drawer being deleted now finishes first; what is done stays.');
    expect(confirmWords(job({ kind: 'write', writes: [w({ kind: 'rename', status: 'running' }), w()] })))
      .toBe('Cancel the rest of these changes? What is done stays.');
  });
  it('askingAbout: the job the dialog asks about while it still runs, its latest answer; else null', () => {
    const now = job({ done: 5 });
    expect(askingAbout('j1', [job({ id: 'j2' }), now])).toBe(now);
    expect(askingAbout('j1', [done()])).toBeNull();
    expect(askingAbout('j1', [])).toBeNull();
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

describe('timeLeft with small files (A500 bench 2026-11-02: "about 28 min left" for 3)', () => {
  const t0 = 1_000_000;
  const run = (o: { done: number; ended: number }, at: number) => ({ at: t0 + at, ...o });
  it('files going faster than their bytes suggest: the time of the files left', () => {
    // 30 files ended in 30 s, 3 KB through, 30 files and 27 KB to go: 270 s by bytes, 30 s by files.
    const samples = [run({ done: 0, ended: 0 }, 0), run({ done: 1500, ended: 15 }, 15_000), run({ done: 3000, ended: 30 }, 30_000)];
    expect(timeLeft(samples, { bytes: { total: 30_000, done: 3000 }, offline: null, running: true, waiting: 30 }, t0 + 30_000)).toBe(30);
  });
  it('one big file left, moving: the bytes say how long, not the files', () => {
    const samples = [run({ done: 0, ended: 0 }, 0), run({ done: 15_000, ended: 1 }, 15_000), run({ done: 30_000, ended: 2 }, 30_000)];
    expect(timeLeft(samples, { bytes: { total: 40_000, done: 30_000 }, offline: null, running: true, waiting: 10 }, t0 + 30_000)).toBe(10);
  });
  it('one file left after a run of small ones: the bytes alone', () => {
    const samples = [run({ done: 0, ended: 0 }, 0), run({ done: 1500, ended: 15 }, 15_000), run({ done: 3000, ended: 30 }, 30_000)];
    expect(timeLeft(samples, { bytes: { total: 30_000, done: 3000 }, offline: null, running: true, waiting: 1 }, t0 + 30_000)).toBe(270);
  });
  it('fewer than two files through in the window: the bytes alone', () => {
    const samples = [run({ done: 0, ended: 0 }, 0), run({ done: 1500, ended: 0 }, 15_000), run({ done: 3000, ended: 1 }, 30_000)];
    expect(timeLeft(samples, { bytes: { total: 30_000, done: 3000 }, offline: null, running: true, waiting: 1 }, t0 + 30_000)).toBe(270);
  });
});

describe('timeLeft over a whole job (Pillock 2026-11-04: Monkey Island disks read from 1 min to 9 min)', () => {
  // Four disks: ten 1 KB files at 3 s each, then an 800 KB file at 3 s + 20 s. The job's bytes move as each file ends.
  const files = Array.from({ length: 4 }, () => [...Array.from({ length: 10 }, () => ({ kb: 1, s: 3 })), { kb: 800, s: 23 }]).flat();
  const totalS = files.reduce((n, f) => n + f.s, 0);
  const totalB = files.reduce((n, f) => n + f.kb * 1024, 0);
  function run(useFit: boolean) {
    const t0 = 1_000_000; const out: { est: number; truth: number }[] = [];
    let samples: Sample[] = []; let fit: Fit | undefined;
    for (let sec = 0; sec < totalS; sec += 2) {
      let t = 0, done = 0, ended = 0;
      for (const f of files) { if (t + f.s > sec) break; t += f.s; done += f.kb * 1024; ended++; }
      const at = t0 + sec * 1000;
      const s: Sample = { at, done, ended };
      samples = [...samples, s].filter((x) => x.at >= at - 30_000);
      fit = addToFit(fit, s);
      const est = timeLeft(samples, { bytes: { total: totalB, done }, offline: null, running: true, waiting: files.length - ended }, at, useFit ? fit : undefined);
      if (est !== null && sec >= totalS / 4) out.push({ est, truth: totalS - sec });
    }
    return out;
  }
  it('stays near the real time left, from a quarter of the way on', () => {
    const r = run(true);
    expect(r.length).toBeGreaterThan(50);
    for (const { est, truth } of r) if (truth > 30) { expect(est).toBeGreaterThan(truth * 0.6); expect(est).toBeLessThan(truth * 1.5); }
  });
  it('the last 30 s alone do not, which is why the fit is there', () => {
    const r = run(false);
    expect(r.some(({ est, truth }) => truth > 30 && (est < truth * 0.6 || est > truth * 1.5))).toBe(true);
  });
  it('with files all alike the fit cannot part files from bytes, and the last 30 s answer', () => {
    let fit: Fit | undefined; const t0 = 1_000_000;
    const samples: Sample[] = [0, 15, 30].map((n) => ({ at: t0 + n * 1000, done: n * 100, ended: n }));
    for (const s of samples) fit = addToFit(fit, s);
    expect(timeLeft(samples, { bytes: { total: 30_000, done: 3000 }, offline: null, running: true, waiting: 30 }, t0 + 30_000, fit)).toBe(30);
  });
  it('a stall in the middle does not skew the rest (final review: 644 s said for 144 s after a 300 s wait)', () => {
    const t0 = 1_000_000; let fit: Fit | undefined; let at = t0; let done = 0; let ended = 0;
    const left = files.map((f) => f);
    fit = addToFit(fit, { at, done, ended });
    let est: number | null = null; let truth = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      at += (f.s + (i === 15 ? 300 : 0)) * 1000; done += f.kb * 1024; ended++;
      fit = addToFit(fit, { at, done, ended });
      if (i === 16) {
        truth = left.slice(17).reduce((n, x) => n + x.s, 0);
        const samples: Sample[] = [{ at: at - 12_000, done: done - 2048, ended: ended - 2 }, { at: at - 11_000, done: done - 1024, ended: ended - 1 }, { at, done, ended }];
        est = timeLeft(samples, { bytes: { total: totalB, done }, offline: null, running: true, waiting: files.length - ended }, at, fit);
      }
    }
    expect(est).toBeGreaterThan(truth * 0.6);
    expect(est).toBeLessThan(truth * 1.5);
  });
  it('the wait before the first file counts for nothing', () => {
    const a = addToFit(undefined, { at: 0, done: 0, ended: 0 });
    const b = addToFit(a, { at: 600_000, done: 1024, ended: 1 });
    expect(b.tb).toBe(0);
    expect(b.from.at).toBe(600_000);
  });
  it('a poll with nothing new leaves the fit waiting, so a long file counts its whole time', () => {
    const a = addToFit(undefined, { at: 0, done: 0, ended: 0 });
    const b = addToFit(a, { at: 2000, done: 0, ended: 0 });
    expect(b).toBe(a);
    const c = addToFit(addToFit(b, { at: 20_000, done: 1024, ended: 1 }), { at: 40_000, done: 2048, ended: 2 });
    expect(c.tb).toBe(20);
  });
});
