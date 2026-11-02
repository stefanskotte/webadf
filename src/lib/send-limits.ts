/**
 * Limits shared by the server's send queue and the browser (spec 2026-10-16 D4; the gate is ruling R1 of plan
 * 2026-10-17: 1.14.0 builds stall the link, HANDOFF 3bu). No imports, so client components can use it.
 */
export const XFER_FW = '1.15.0';
export const SEND_FILE_MAX = 4_194_304;
/**
 * What one board's queue holds (spec 2026-11-02 part 1): a whole disk, or several, in one go. The byte limit stays below
 * what a day's slowest speed (2.2 KB/s, a chip-only A600) can move before the 24-hour expiry.
 */
export const SEND_QUEUE_MAX_FILES = 1000;
export const SEND_QUEUE_MAX_BYTES = 128 * 1024 * 1024;

/** The words for a refused queue, built from the limits so they cannot drift from them. */
export function queueFullWords(): string {
  return `The board's queue holds ${SEND_QUEUE_MAX_FILES.toLocaleString('en-US')} files / ${SEND_QUEUE_MAX_BYTES / (1024 * 1024)} MB; wait for it to empty or cancel some.`;
}
