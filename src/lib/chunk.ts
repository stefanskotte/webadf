/**
 * Splits an array into groups of at most `n`. Used to keep any single
 * request under the ingest API's per-batch cap (MAX_BATCH in
 * src/lib/ingest.ts) -- both the browser dropzone (src/components/ingest/
 * dropzone.tsx) and the CLI (cli/src/index.ts) chunk their file lists with
 * this same shape before calling check/presign/complete, so a collection
 * larger than one batch (an ordinary thing to drop -- the real library is
 * ~18,000 disks) is actually processed instead of overflowing the server's
 * Zod .max() into a 400.
 */
export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
