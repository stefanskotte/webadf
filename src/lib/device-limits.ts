/**
 * Bounds the firmware imposes on what the poll body may carry.
 *
 * These are the C values, restated here so the server can respect them --
 * `wifi-floppy/firmware/src/device_client.h` is the source of truth and
 * src/lib/device-limits.test.ts fails if these drift from it.
 *
 * Why the server cares: the firmware's poll buffer is a fixed
 * DC_POLL_BODY_BYTES, and it REFUSES a truncated body outright rather than
 * losing whatever fell off the end. `games.title` and `disks.label` are
 * `text` columns with no length limit, so without a bound a single long
 * TOSEC title could push a body past the buffer and stop a board mounting
 * and ejecting altogether -- a failure with no obvious cause, triggered by
 * ordinary data.
 *
 * Truncating costs nothing the board could have used: it copies into
 * `char title[DC_TITLE_MAX + 1]` and truncates to exactly this anyway.
 */
export const DC_TITLE_MAX = 48;
export const DC_LABEL_MAX = 24;
