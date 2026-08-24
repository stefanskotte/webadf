/**
 * Shared by BOTH upload clients — src/components/ingest/dropzone.tsx (browser)
 * and cli/src/index.ts (Node, which imports this file directly across the
 * package boundary). Deliberately dependency-free and free of any node:/DOM
 * import so both can use it. There is exactly one copy of this rule: getting
 * it wrong in one client and not the other is how the MAX_BATCH divergence
 * silently ate a whole batch.
 */

/**
 * True when a presigned PUT was refused *because the object is already there*.
 *
 * Why this is a SUCCESS, not a failure. Blobs are content-addressed at
 * adf/<sha256> and presigned with allowOverwrite: false, so a second PUT of
 * the same key is rejected with 400. That happens without any attacker: a
 * batch where one PUT fails throws out of the caller's Promise.all before
 * /api/ingest/complete runs, so the *other* files in that batch are sitting
 * in the store with no `blobs` row. /api/ingest/check is DB-backed, so the
 * next run reports them missing, presigns them again, PUTs again — and gets
 * this same 400 forever. Treating it as a failure wedges that file
 * permanently; treating it as "the bytes are already there" lets the file
 * reach /complete, which verifies the stored bytes and writes the missing
 * row. Reconciliation, not a dead end.
 *
 * Matched on the message rather than the code because Vercel Blob returns the
 * generic code "bad_request" for this (verified live against the real store):
 *   {"error":{"code":"bad_request","message":"This blob already exists, use
 *    `allowOverwrite: true` ..."}}
 *
 * Deliberately narrow. Swallowing every 400 would re-hide the oversized-batch
 * bug fixed earlier, and would turn a genuinely rejected upload (over the
 * signed maximumSizeInBytes, say) into a silent success.
 */
/**
 * Hard ceiling on a single disk image. An uncompressed Amiga DD floppy is
 * 901,120 bytes and an HD one is 1,802,240; 2 MiB covers both with room for
 * the odd oversized dump, and nothing legitimate in an ADF archive is bigger.
 * The server enforces this in presignBody (src/lib/ingest.ts, which imports
 * this constant) — clients screen against the SAME number so a single bad
 * file is reported as that one file's problem instead of 400-ing the presign
 * call for the other 499 files in its batch.
 */
export const MAX_DISK_BYTES = 2 * 1024 * 1024;

/**
 * True when a file can possibly be presigned. Catches the two shapes that
 * really turn up in a scraped archive: the zero-byte .adf (a truncated
 * download) and something far too large to be a floppy image.
 */
export function isUploadableSize(sizeBytes: number): boolean {
  return Number.isInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= MAX_DISK_BYTES;
}

export function isBlobAlreadyExists(status: number, body: string): boolean {
  return status === 400 && /this blob already exists/i.test(body);
}

/** Vercel Blob's presigned URLs carry a 1 h TTL; an expired one answers 403. */
export function isExpiredPresign(status: number): boolean {
  return status === 403;
}

export type UploadOutcome =
  /** Bytes were written by this PUT. */
  | 'uploaded'
  /** Bytes were already in the store — soft success, must still be completed. */
  | 'already-stored'
  /** Nothing usable landed; the file must be excluded from /complete. */
  | 'failed';

/** Classifies a PUT response. `body` may be '' when it could not be read. */
export function classifyUpload(status: number, ok: boolean, body: string): UploadOutcome {
  if (ok) return 'uploaded';
  if (isBlobAlreadyExists(status, body)) return 'already-stored';
  return 'failed';
}
