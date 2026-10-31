// NET: volumes (spec 2026-10-30): the numbers the board, the server and the pane share. CLIENT-SAFE.
export const BROWSE_FW = '1.22.0';
export const BROWSE_PROTO = 3;
export const REMEMBER_MS = 120_000;          // a done listing is reused this long (V3)
export const PANE_ASK_MS = 500;              // the pane re-asks a pending listing this often
export const PANE_GIVE_UP_MS = 20_000;       // ... and stops after this long
export const FAILED_SHOWN_MS = 10_000;       // a failed answer is shown to re-asks this long, then a visit asks again
export const LIST_TIMEOUT_MS = 60_000;       // a vols/dir request this long past its last sign of life fails `timeout`
export const GET_TIMEOUT_MS = 600_000;       // a get not done 10 minutes after it was sent fails `timeout`
export const REQUEST_KEEP_MS = 24 * 3600_000;
export const REQ_FETCH_MAX = 8;              // requests per GET /api/device/req
export const FETCH_MAX_FILES = 64;
export const FETCH_MAX_BYTES = 16 * 1024 * 1024;
export const DIR_CUT = 1000;
export const QUEUE_FOLDER = 'Queue';
// NET: volumes phase 2 (spec 2026-10-31): writing to the Amiga's own disks.
export const WRITE_FW = '1.23.0';
export const WRITE_PROTO = 4;
/** Spec 2026-10-31 §9: Transfer 2.6 (protocol 5) deletes exactly one object (`DELETE … one`); a move that copies needs it. */
export const MOVE_PROTO = 5;
export const ALIVE_PIECE_MS = 30_000;        // a listing arriving in pieces is alive while one came this recently (§4.4)
export const WRITE_KINDS = ['mkdir', 'rename', 'delete', 'protect', 'note'] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];
export const DEL_EVERY = 50;                 // Transfer sends DEL <rid> <n> after every 50 entries removed (§2.3)
