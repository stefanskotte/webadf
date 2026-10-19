/**
 * Uploads from the Amiga (spec 2026-10-18 U5, §4, §5): the limits the server, the board and the browser share. No
 * imports, so client components can use it.
 */
export const UPLOAD_FW = '1.19.0';
export const UPLOAD_FILE_MAX = 4_194_304;                 // = SEND_FILE_MAX and Receive's RX_FILE_MAX
export const UPLOAD_CHUNK = 16_384;                        // = the board's AS_CHUNK_BYTES
export const UPLOAD_AREA_MAX_FILES = 500;                  // per org
export const UPLOAD_AREA_MAX_BYTES = 256 * 1024 * 1024;    // per org
export const UPLOAD_KEEP_MS = 30 * 24 * 3600_000;          // a stored file is kept 30 days
export const UPLOAD_RESUME_MS = 24 * 3600_000;             // a partial upload resumes for 24 h
