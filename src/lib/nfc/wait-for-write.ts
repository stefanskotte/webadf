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
 *
 * A cancel that itself fails is carried as `cancelError` alongside whatever
 * ended the loop -- the ORIGINAL reason (a thrown read, a timeout, or a
 * cancellation request) is never replaced by the cancel's own failure. Fix
 * round 1 got this wrong for the thrown-read case: a failing cancel there
 * discarded the original error entirely, which is exactly the "operator sees
 * nothing useful" failure mode this module exists to prevent.
 */

export type WaitForWriteResult =
  | { kind: 'ok'; uid: string | null }
  | { kind: 'failed'; reason: string; uid: string | null }
  | { kind: 'timeout'; cancelError?: unknown }
  | { kind: 'cancelled'; cancelError?: unknown }
  | { kind: 'error'; error: unknown; cancelError?: unknown };

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

/** Best-effort: never throws. Returns the cancel's own error, if it failed,
 *  so the caller can attach it to whatever original reason it already has --
 *  rather than letting a cancel failure stand in for that reason. */
async function tryCancel(deps: WaitForWriteDeps): Promise<{ cancelError?: unknown }> {
  try {
    await deps.cancelNfcWrite(deps.deviceId, deps.seq);
    return {};
  } catch (cancelError) {
    return { cancelError };
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
      const { cancelError } = await tryCancel(deps);
      return cancelError === undefined ? { kind: 'error', error } : { kind: 'error', error, cancelError };
    }
    if (result) return answered(result);
  }

  const { cancelError } = await tryCancel(deps);
  // The board may have answered between the last poll and the cancel. The
  // cancel moves the cursor but leaves the stored answer for `seq` readable,
  // so one re-read tells a write that DID land apart from a real timeout.
  // Best-effort: a failing re-read keeps the original timeout/cancelled.
  try {
    const late = await readWriteResult(deviceId, seq);
    if (late) return answered(late);
  } catch {
    // fall through to the timeout/cancelled report
  }
  const kind = isCancelled() ? 'cancelled' as const : 'timeout' as const;
  return cancelError === undefined ? { kind } : { kind, cancelError };
}

function answered(r: { result: string; uid: string | null }): WaitForWriteResult {
  return r.result === 'ok'
    ? { kind: 'ok', uid: r.uid }
    : { kind: 'failed', reason: r.result, uid: r.uid };
}
