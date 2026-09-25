/**
 * NFC tap-to-mount's decisions, pure (spec 2026-09-25 §5). The routes and the
 * CLI do the I/O; everything that decides lives here so it can be tested
 * without a database.
 */

/** The shape stableId() produces (src/lib/ingest.ts). Every disk insert uses
 *  it (checked 2026-09-25); a new creation path that does not must widen this. */
export const DISK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const TAP_MIN_INTERVAL_MS = 1000;
export const NFC_WRITE_TTL_MS = 120_000;

export type TapOutcome = 'mounting' | 'already' | 'not_found' | 'too_long' | 'ignored';

/** D2: a different disk swaps, the desired one is a no-op, and a burst is ignored. */
export function decideTap(
  row: { desiredDiskId: string | null; lastTapAt: Date | null },
  diskId: string, now: Date,
): 'ignored' | 'already' | 'mount' {
  if (row.lastTapAt && now.getTime() - row.lastTapAt.getTime() < TAP_MIN_INTERVAL_MS) return 'ignored';
  if (row.desiredDiskId === diskId) return 'already';
  return 'mount';
}

/**
 * What the poll tells the board about writing, given the cursor it sent.
 * null = nothing to say (up to date, ahead of us, or never asked). A request
 * that is cancelled, expired or already answered is still delivered -- as
 * diskId null, "disarm" -- so the board's cursor catches up and the hold
 * does not keep releasing forever.
 */
export function nfcWriteForPoll(
  row: { nfcWriteSeq: number; nfcWriteDiskId: string | null; nfcWriteExpiresAt: Date | null; nfcWriteResultSeq: number | null },
  ack: number, now: Date,
): { seq: number; diskId: string | null } | null {
  if (row.nfcWriteSeq <= ack) return null;
  const live = row.nfcWriteDiskId !== null
    && row.nfcWriteExpiresAt !== null && now.getTime() <= row.nfcWriteExpiresAt.getTime()
    && row.nfcWriteResultSeq !== row.nfcWriteSeq;
  return { seq: row.nfcWriteSeq, diskId: live ? row.nfcWriteDiskId : null };
}

/** Only the first answer to the CURRENT request counts. */
export function shouldStoreWriteResult(
  row: { nfcWriteSeq: number; nfcWriteResultSeq: number | null }, reportSeq: number,
): boolean {
  return reportSeq === row.nfcWriteSeq && row.nfcWriteResultSeq !== reportSeq;
}
