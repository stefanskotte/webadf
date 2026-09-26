import { describe, it, expect, vi } from 'vitest';
import { waitForWrite, type WaitForWriteDeps } from './wait-for-write';

const DEVICE_ID = 'device-1';
const SEQ = 7;

/** A deps object with fakes for everything, overridable per test. Time never
 *  really passes -- `sleep` resolves immediately and `now` is driven by the
 *  test, so nothing here waits on the real clock. */
function makeDeps(over: Partial<WaitForWriteDeps> = {}) {
  const cancelNfcWrite = vi.fn().mockResolvedValue(undefined);
  const readWriteResult = vi.fn().mockResolvedValue(null);
  const deps: WaitForWriteDeps = {
    deviceId: DEVICE_ID,
    seq: SEQ,
    deadline: 10_000,
    pollMs: 1000,
    isCancelled: () => false,
    sleep: vi.fn().mockResolvedValue(undefined),
    now: () => 0,
    readWriteResult,
    cancelNfcWrite,
    ...over,
  };
  return { deps, cancelNfcWrite, readWriteResult };
}

describe('waitForWrite', () => {
  it('an ok result ends the wait without cancelling', async () => {
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps();
    readWriteResult.mockResolvedValue({ result: 'ok', uid: 'AA:BB' });
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'ok', uid: 'AA:BB' });
    expect(cancelNfcWrite).not.toHaveBeenCalled();
  });

  it('a failure result ends the wait without cancelling', async () => {
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps();
    readWriteResult.mockResolvedValue({ result: 'auth_failed', uid: 'AA:BB' });
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'failed', reason: 'auth_failed', uid: 'AA:BB' });
    expect(cancelNfcWrite).not.toHaveBeenCalled();
  });

  it('running out of time cancels exactly once and reports a timeout', async () => {
    let time = 0;
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps({
      now: () => time,
      sleep: vi.fn().mockImplementation(async () => { time += 1000; }),
    });
    readWriteResult.mockResolvedValue(null); // never answers
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'timeout' });
    expect(cancelNfcWrite).toHaveBeenCalledTimes(1);
    expect(cancelNfcWrite).toHaveBeenCalledWith(DEVICE_ID, SEQ);
  });

  it('a cancellation request (e.g. SIGINT) cancels exactly once and reports cancelled', async () => {
    let cancelled = false;
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps({
      isCancelled: () => cancelled,
      sleep: vi.fn().mockImplementation(async () => { cancelled = true; }),
    });
    readWriteResult.mockResolvedValue(null);
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'cancelled' });
    expect(cancelNfcWrite).toHaveBeenCalledTimes(1);
    // Never polled inside the loop -- only the single re-read AFTER the cancel.
    expect(readWriteResult).toHaveBeenCalledTimes(1);
    expect(cancelNfcWrite.mock.invocationCallOrder[0])
      .toBeLessThan(readWriteResult.mock.invocationCallOrder[0]);
  });

  it('a thrown readWriteResult cancels exactly once and reports the error, instead of unwinding uncaught', async () => {
    const boom = new Error('DB unreachable');
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps();
    readWriteResult.mockRejectedValue(boom);
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'error', error: boom });
    expect(cancelNfcWrite).toHaveBeenCalledTimes(1);
    expect(cancelNfcWrite).toHaveBeenCalledWith(DEVICE_ID, SEQ);
  });

  it('a cancel that itself fails after a thrown read preserves the ORIGINAL read error, alongside the cancel failure (never throws out)', async () => {
    const readBoom = new Error('DB unreachable');
    const cancelBoom = new Error('cancel also failed');
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps();
    readWriteResult.mockRejectedValue(readBoom);
    cancelNfcWrite.mockRejectedValue(cancelBoom);
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'error', error: readBoom, cancelError: cancelBoom });
    expect(cancelNfcWrite).toHaveBeenCalledTimes(1);
  });

  it('a cancel that fails on a plain timeout still reports the timeout, with the cancel failure attached (never throws out)', async () => {
    let time = 0;
    const cancelBoom = new Error('cancel failed');
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps({
      now: () => time,
      sleep: vi.fn().mockImplementation(async () => { time += 1000; }),
    });
    readWriteResult.mockResolvedValue(null);
    cancelNfcWrite.mockRejectedValue(cancelBoom);
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'timeout', cancelError: cancelBoom });
    expect(cancelNfcWrite).toHaveBeenCalledTimes(1);
  });

  it('a cancel that fails on a SIGINT cancellation still reports cancelled, with the cancel failure attached', async () => {
    let cancelled = false;
    const cancelBoom = new Error('cancel failed');
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps({
      isCancelled: () => cancelled,
      sleep: vi.fn().mockImplementation(async () => { cancelled = true; }),
    });
    readWriteResult.mockResolvedValue(null);
    cancelNfcWrite.mockRejectedValue(cancelBoom);
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'cancelled', cancelError: cancelBoom });
    expect(cancelNfcWrite).toHaveBeenCalledTimes(1);
  });

  it('a result that lands just before the timeout cancel is reported, not "Timed out"', async () => {
    // The board answered between the last poll and the cancel. The cancel
    // bumps the cursor but leaves the stored result for `seq` readable, so
    // one re-read after cancelling finds it.
    let time = 0;
    let landed = false;
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps({
      now: () => time,
      sleep: vi.fn().mockImplementation(async () => { time += 1000; }),
    });
    cancelNfcWrite.mockImplementation(async () => { landed = true; });
    readWriteResult.mockImplementation(async () => (landed ? { result: 'ok', uid: 'AA:BB' } : null));
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'ok', uid: 'AA:BB' });
    expect(cancelNfcWrite).toHaveBeenCalledTimes(1);
  });

  it('a failure result that lands just before a SIGINT cancel is reported as that failure', async () => {
    let cancelled = false;
    const { deps, readWriteResult } = makeDeps({
      isCancelled: () => cancelled,
      sleep: vi.fn().mockImplementation(async () => { cancelled = true; }),
    });
    readWriteResult.mockResolvedValue({ result: 'verify_failed', uid: 'CC:DD' });
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'failed', reason: 'verify_failed', uid: 'CC:DD' });
  });

  it('a re-read that throws after the cancel still reports the timeout (never throws out)', async () => {
    let time = 0;
    let cancelledAlready = false;
    const { deps, cancelNfcWrite, readWriteResult } = makeDeps({
      now: () => time,
      sleep: vi.fn().mockImplementation(async () => { time += 1000; }),
    });
    cancelNfcWrite.mockImplementation(async () => { cancelledAlready = true; });
    readWriteResult.mockImplementation(async () => {
      if (cancelledAlready) throw new Error('DB gone');
      return null;
    });
    await expect(waitForWrite(deps)).resolves.toEqual({ kind: 'timeout' });
  });
});
