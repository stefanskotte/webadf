/**
 * How often an open tab asks whether the org's device state changed.
 *
 * A visible tab polls for as long as it is open, so the cost is real: at 3 s
 * that is ~1,200 requests an hour per tab, each a session lookup plus one
 * query, and it keeps the database awake all night for a tab nobody is
 * looking at. Someone actively using the app wants the 3 s answer; a tab left
 * open on a second monitor does not, and the operator asked for the slower
 * rate there (decision, 2026-09-20).
 *
 * "Active" is the last real input in THIS tab, not the last change on the
 * server: a board mounting a disk on its own must not make the tab consider
 * itself in use. Coming back to the tab (a click, a key, a scroll) returns it
 * to 3 s at once -- see LiveRefresh, which polls immediately on that edge
 * rather than waiting out the long delay it had already scheduled.
 */
export const LIVE_POLL_MS = 3_000;
export const LIVE_IDLE_POLL_MS = 30_000;
export const LIVE_IDLE_AFTER_MS = 600_000;   // 10 minutes

/** The delay before the next poll, given when this tab last saw input. */
export function livePollDelay(now: number, lastInputAt: number): number {
  return isIdle(now, lastInputAt) ? LIVE_IDLE_POLL_MS : LIVE_POLL_MS;
}

/** Whether this tab counts as idle: no input for LIVE_IDLE_AFTER_MS. */
export function isIdle(now: number, lastInputAt: number): boolean {
  // Signed difference, so a clock that jumps backwards (a laptop waking, an
  // NTP step) reads as "input just now" rather than as ten minutes of idleness.
  return now - lastInputAt >= LIVE_IDLE_AFTER_MS;
}
