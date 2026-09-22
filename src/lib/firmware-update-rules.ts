import type { ReleaseRef, Registry } from '@/lib/firmware-state';

/**
 * Whether a device may be told to run a particular release.
 *
 * Pure, and called from BOTH sides: the batch route rejects with it, and the
 * Devices page decides whether to offer a checkbox with it. One rule with two
 * readers cannot drift into a UI that offers what the server refuses.
 */
export type TargetRefusal = 'cannot_update' | 'would_roll_back' | 'already_current';

export interface TargetCandidate {
  id: string;
  name: string;
  updateProtocol: number | null;
  firmwareVersion: string | null;
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

  const running = d.firmwareVersion ? reg.byVersion.get(d.firmwareVersion) : undefined;

  // No sequence: either nothing reported, or a build the registry has never
  // seen. Nothing rules it out, and this is the recovery path for a board
  // running something hand-flashed. "Unrecognised" must not become "refused".
  if (!running) return null;

  if (running.sequence === target.sequence) return 'already_current';
  if (running.sequence > target.sequence) return 'would_roll_back';
  return null;
}
