import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, basename } from 'node:path';
import pLimit from 'p-limit';
import { hashFile } from './hash.ts';
// Same repo, imported rather than copied on purpose: the browser dropzone
// applies the identical rule, and the two clients drifting apart is exactly
// how the MAX_BATCH divergence silently ate a whole batch. The module is
// dependency-free and has no node:/DOM import, so both runtimes can load it.
import {
  classifyUpload, isExpiredPresign, isUploadableSize, MAX_DISK_BYTES, type UploadOutcome,
} from '../../src/lib/blob-upload.ts';

const DISK_EXT = new Set(['.adf', '.dsk', '.adz', '.dms', '.hfe']);
const BATCH = 500;
const CONCURRENCY = 6;

type Entry = { path: string; filename: string; sha256: string; sizeBytes: number };
type Failure = { what: string; why: string };

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (DISK_EXT.has(extname(entry.name).toLowerCase())) yield p;
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function main() {
  const [, , cmd, dir] = process.argv;
  const base = process.env.WEBADF_URL ?? 'http://localhost:3000';
  const cookie = process.env.WEBADF_COOKIE;

  if (cmd !== 'push' || !dir) {
    console.error('usage: WEBADF_COOKIE=<session cookie> webadf push <dir>');
    process.exit(1);
  }
  if (!cookie) {
    console.error('WEBADF_COOKIE is required — copy the session cookie from your browser');
    process.exit(1);
  }

  const api = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };

  process.stdout.write('  scanning ....... ');
  const paths: string[] = [];
  for await (const p of walk(dir)) paths.push(p);
  console.log(`${paths.length.toLocaleString()} files`);

  process.stdout.write('  hashing ........ ');
  const limit = pLimit(CONCURRENCY);
  const files: Entry[] = await Promise.all(paths.map((p) => limit(async () => ({
    path: p,
    filename: basename(p),
    sha256: await hashFile(p),
    sizeBytes: (await stat(p)).size,
  }))));
  console.log('done');

  let deduped = 0;
  let uploaded = 0;
  let reconciled = 0;
  let completed = 0;
  const failures: Failure[] = [];

  // One PUT attempt. The body is a fresh stream every call, so a retry after
  // an expired presign cannot re-read a consumed one.
  async function putOnce(url: string, f: Entry) {
    const res = await fetch(url, {
      method: 'PUT',
      body: createReadStream(f.path) as unknown as BodyInit,
      // @ts-expect-error — Node requires duplex for a stream body
      duplex: 'half',
    });
    const body = res.ok ? '' : await res.text().catch(() => '');
    return {
      outcome: classifyUpload(res.status, res.ok, body),
      expired: isExpiredPresign(res.status),
      status: res.status,
    };
  }

  const presignOne = async (f: Entry): Promise<string | null> => {
    try {
      const { uploads } = await api('/api/ingest/presign', {
        files: [{ sha256: f.sha256, sizeBytes: f.sizeBytes }],
      });
      return (uploads as Array<{ sha256: string; url: string }>)[0]?.url ?? null;
    } catch {
      return null;
    }
  };

  // Screened BEFORE any batching. presignBody rejects a non-positive or
  // over-size sizeBytes, and that 400 kills the presign call for the ENTIRE
  // batch -- so one truncated zero-byte .adf in an 18,000-file archive used
  // to cost the 499 good files sharing its batch. Reported as that one
  // file's failure instead.
  const pushable: Entry[] = [];
  for (const f of files) {
    if (isUploadableSize(f.sizeBytes)) pushable.push(f);
    else {
      failures.push({
        what: f.filename,
        why: f.sizeBytes === 0
          ? 'empty file (0 bytes)'
          : `size ${f.sizeBytes} outside 1..${MAX_DISK_BYTES} bytes`,
      });
    }
  }
  if (pushable.length < files.length) {
    console.log(`  skipping ....... ${files.length - pushable.length} unusable file(s)`);
  }

  const batches = chunk(pushable, BATCH);

  for (const [batchNo, group] of batches.entries()) {
    const label = `batch ${batchNo + 1}/${batches.length}`;
    // Per-batch, so one bad batch costs that batch and nothing else. This
    // used to abort the entire push on the first failure of any kind — one
    // expired presign, one zero-byte .adf (rejected by presignBody's
    // positive-size rule), one over-size file — discarding every remaining
    // batch. Worse, an abort here skipped /complete for files that HAD
    // uploaded, leaving them in the store with no blobs row: wedged.
    try {
      const { missing } = await api('/api/ingest/check', { hashes: group.map((f) => f.sha256) });
      const missingSet = new Set<string>(missing);

      // Count DISTINCT hashes, not files: /check collapses duplicates, so
      // `group.length - missingSet.size` over-counted every repeated hash in
      // a batch as a dedupe hit.
      const distinct = new Set(group.map((f) => f.sha256));
      deduped += distinct.size - missingSet.size;

      const toUpload = group.filter((f) => missingSet.has(f.sha256));
      // Bytes that are in the store, whether this run put them there or a
      // previous aborted run did. Only these may be sent to /complete.
      const stored = new Set<string>(group.filter((f) => !missingSet.has(f.sha256)).map((f) => f.sha256));

      if (toUpload.length > 0) {
        const { uploads } = await api('/api/ingest/presign', {
          files: toUpload.map((f) => ({ sha256: f.sha256, sizeBytes: f.sizeBytes })),
        });
        const urlFor = new Map<string, string>(
          (uploads as Array<{ sha256: string; url: string }>).map((u) => [u.sha256, u.url]),
        );

        // Counted per batch: this used to print a cumulative numerator
        // against a per-batch denominator, so batch 2 of an 18k run read
        // "730/500".
        let done = 0;
        await Promise.all(toUpload.map((f) => limit(async () => {
          let outcome: UploadOutcome = 'failed';
          let why = '';
          try {
            const url = urlFor.get(f.sha256);
            if (!url) throw new Error('no presigned url returned');
            const first = await putOnce(url, f);
            outcome = first.outcome;
            why = `HTTP ${first.status}`;
            if (first.expired) {
              // 403 = the 1 h presign TTL ran out mid-batch. Ask for one
              // fresh URL for this file and try again once, rather than
              // failing a file whose bytes are perfectly good.
              const fresh = await presignOne(f);
              if (fresh) {
                const second = await putOnce(fresh, f);
                outcome = second.outcome;
                why = `HTTP ${second.status} after re-presign`;
              }
            }
          } catch (err) {
            outcome = 'failed';
            why = err instanceof Error ? err.message : String(err);
          }

          if (outcome === 'failed') {
            failures.push({ what: f.filename, why: `upload failed (${why})` });
          } else {
            // 'already-stored' is a SOFT SUCCESS. The bytes are at
            // adf/<sha> already (a previous run PUT them and then died
            // before /complete), so the file must still be completed —
            // otherwise its blobs row is never written, /check keeps
            // reporting it missing, and every future run re-PUTs and hits
            // the same 400 forever. Including it here is what reconciles
            // that state instead of wedging it.
            stored.add(f.sha256);
            if (outcome === 'uploaded') uploaded++;
            else reconciled++;
          }
          done++;
          process.stdout.write(`\r  uploading ...... ${done}/${toUpload.length} (${label})`);
        })));
        process.stdout.write('\n');
      }

      const toComplete = group.filter((f) => stored.has(f.sha256));
      if (toComplete.length > 0) {
        const result = await api('/api/ingest/complete', {
          files: toComplete.map((f) => ({
            sha256: f.sha256, sizeBytes: f.sizeBytes, filename: f.filename,
          })),
        });
        completed += toComplete.length;
        const rejected = (result?.rejected ?? []) as string[];
        const reasons = (result?.rejectedReasons ?? {}) as Record<string, string>;
        for (const sha of rejected) {
          const f = toComplete.find((x) => x.sha256 === sha);
          failures.push({
            what: f?.filename ?? sha.slice(0, 12),
            why: `rejected at /complete: ${reasons[sha] ?? 'unknown'}`,
          });
        }
      }
    } catch (err) {
      failures.push({ what: label, why: err instanceof Error ? err.message : String(err) });
      console.error(`\n  ! ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `\n  ✓ ${uploaded} uploaded, ${reconciled} reconciled, ${deduped} already stored, ${completed} catalogued`,
  );

  if (failures.length > 0) {
    console.error(`\n  ✗ ${failures.length} failure${failures.length === 1 ? '' : 's'}:`);
    // Capped so one systemic failure cannot bury the summary under 18,000 lines.
    for (const f of failures.slice(0, 20)) console.error(`      ${f.what}: ${f.why}`);
    if (failures.length > 20) console.error(`      ... and ${failures.length - 20} more`);
    // Non-zero: a partial push must never look like a clean one to a script
    // or a shell prompt.
    process.exit(1);
  }
}

main().catch((err) => { console.error('\n' + err.message); process.exit(1); });
