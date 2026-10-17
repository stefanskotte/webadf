/**
 * Limits shared by the server's send queue and the browser (spec 2026-10-16 D4; the gate is ruling R1 of plan
 * 2026-10-17: 1.14.0 builds stall the link, HANDOFF 3bu). No imports, so client components can use it.
 */
export const XFER_FW = '1.15.0';
export const SEND_FILE_MAX = 4_194_304;
export const SEND_QUEUE_MAX_FILES = 32;
export const SEND_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
