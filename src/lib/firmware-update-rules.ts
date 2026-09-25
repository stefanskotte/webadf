import type { ReleaseRef, Registry } from '@/lib/firmware-state';

/**
 * Whether a device may be told to run a particular release.
 *
 * Pure, and called from BOTH sides: the batch route rejects with it, and the
 * Devices page decides whether to offer a checkbox with it. One rule with two
 * readers cannot drift into a UI that offers what the server refuses.
 */
export type TargetRefusal =
  | 'cannot_update'
  | 'would_roll_back'
  | 'already_current'
  | 'update_in_flight'
  | 'unverifiable_release';

export interface TargetCandidate {
  id: string;
  name: string;
  updateProtocol: number | null;
  firmwareVersion: string | null;
  /** What it has already been told to run, if anything. */
  desiredFirmwareVersion?: string | null;
  /** What it says it is doing about that. */
  firmwareUpdateState?: string | null;
}

export function refuseTarget(
  d: TargetCandidate,
  target: ReleaseRef,
  reg: Registry,
): TargetRefusal | null {
  // The capability gate. It protects the poll as well as the UI: a board that
  // cannot report update state could otherwise release the hold forever
  // (spec 4.2), because the hold releases while the state is unacknowledged.
  if (!d.updateProtocol || d.updateProtocol < 1) return 'cannot_update';

  // A release the board cannot verify is never offered (readFirmwareInstruction
  // filters it out). Targeting it would leave the card on "update requested"
  // forever, so refuse it up front.
  if ((target.signatureFormat ?? 1) < 2) return 'unverifiable_release';

  // A board that is already downloading or writing flash must not be
  // re-targeted. Re-requesting resets its reported state, which both erases
  // the live progress the operator is watching and re-arms the wake -- so the
  // instruction would be re-issued to a board mid-flash while its card
  // silently reverted from "do not power off" to "update requested".
  //
  // 'queued' and 'failed' are deliberately NOT in flight: queued means the
  // board is waiting for an eject and re-pointing it is harmless, and failed
  // is exactly the state an operator needs to be able to retry out of.
  if (d.firmwareUpdateState === 'downloading' || d.firmwareUpdateState === 'applying') {
    return 'update_in_flight';
  }

  const running = d.firmwareVersion ? reg.byVersion.get(d.firmwareVersion) : undefined;

  // No sequence: either nothing reported, or a build the registry has never
  // seen. Nothing rules it out, and this is the recovery path for a board
  // running something hand-flashed. "Unrecognised" must not become "refused".
  if (!running) return null;

  if (running.sequence === target.sequence) return 'already_current';
  if (running.sequence > target.sequence) return 'would_roll_back';
  return null;
}

/**
 * The most boards one update request may name.
 *
 * Here, in the pure module both sides already share, so the route's schema
 * and the Devices page's update bar read ONE number. The server alone used to
 * know it: a 51st tick went through the dialog and the password, then came
 * back as a bare 400 the client could only call "Could not request the
 * update." -- nothing in it said what to change.
 */
export const MAX_UPDATE_BATCH = 50;

/** How many boards to untick before a selection of `count` may be sent; 0 when it may. */
export function overBatchCap(count: number): number {
  return Math.max(0, count - MAX_UPDATE_BATCH);
}
