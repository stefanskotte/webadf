/**
 * The `nfc:write` script's poll-and-cancel loop, pulled out of the script so
 * it can be unit-tested with injected I/O (no live database). It owns every
 * exit path after a write request has been armed: cancel the request on
 * every one of them except the two where the board has already answered
 * (`ok` and `failed`) -- an answered request needs no cancel, and cancelling
 * it anyway would just be a wasted round trip.
 *
 * In particular, a `readWriteResult` that THROWS (a transient DB error while
 * the board is armed) used to unwind straight out of `main()` -- which was
 * invoked bare, with no `.catch()` -- leaving the board armed until its own
 * 2-minute expiry and the operator with nothing but an unhandled-rejection
 * dump. That path now cancels too, and reports as an `error` outcome.
 */

export type WaitForWriteResult =
  | { kind: 'ok'; uid: string | null }
  | { kind: 'failed'; reason: string; uid: string | null }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown };

export type WaitForWriteDeps = {
  deviceId: string;
  seq: number;
  /** Epoch ms after which polling gives up. */
  deadline: number;
  pollMs: number;
  /** True once the operator has asked to stop (e.g. SIGINT). */
  isCancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Epoch ms "now" -- injected so a test never waits for real time. */
  now: () => number;
  readWriteResult: (deviceId: string, seq: number) => Promise<{ result: string; uid: string | null } | null>;
  cancelNfcWrite: (deviceId: string, seq: number) => Promise<void>;
};

/** Best-effort: a cancel that itself fails must not hide the original reason
 *  the loop is ending -- unless there IS no original reason (the loop simply
 *  ran out of time or was told to stop), in which case the cancel failure
 *  becomes the thing to report. */
async function cancelReporting(deps: WaitForWriteDeps, onCancelFailure: (error: unknown) => WaitForWriteResult): Promise<WaitForWriteResult | null> {
  try {
    await deps.cancelNfcWrite(deps.deviceId, deps.seq);
    return null;
  } catch (error) {
    return onCancelFailure(error);
  }
}

export async function waitForWrite(deps: WaitForWriteDeps): Promise<WaitForWriteResult> {
  const { deadline, pollMs, isCancelled, sleep, now, readWriteResult, deviceId, seq } = deps;

  while (now() < deadline) {
    if (isCancelled()) break;
    await sleep(pollMs);
    if (isCancelled()) break;

    let result;
    try {
      result = await readWriteResult(deviceId, seq);
    } catch (error) {
      const cancelFailure = await cancelReporting(deps, (e) => ({ kind: 'error', error: e }));
      return cancelFailure ?? { kind: 'error', error };
    }
    if (result) {
      return result.result === 'ok'
        ? { kind: 'ok', uid: result.uid }
        : { kind: 'failed', reason: result.result, uid: result.uid };
    }
  }

  const cancelFailure = await cancelReporting(deps, (error) => ({ kind: 'error', error }));
  if (cancelFailure) return cancelFailure;
  return isCancelled() ? { kind: 'cancelled' } : { kind: 'timeout' };
}
