import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, basename } from 'node:path';
import pLimit from 'p-limit';
import { hashFile } from './hash.ts';

const DISK_EXT = new Set(['.adf', '.dsk', '.adz', '.dms']);
const BATCH = 500;
const CONCURRENCY = 6;

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
  const files = await Promise.all(paths.map((p) => limit(async () => ({
    path: p,
    filename: basename(p),
    sha256: await hashFile(p),
    sizeBytes: (await stat(p)).size,
  }))));
  console.log('done');

  let deduped = 0;
  let uploaded = 0;

  for (const group of chunk(files, BATCH)) {
    const { missing } = await api('/api/ingest/check', { hashes: group.map((f) => f.sha256) });
    const missingSet = new Set<string>(missing);
    deduped += group.length - missingSet.size;

    const toUpload = group.filter((f) => missingSet.has(f.sha256));
    if (toUpload.length > 0) {
      const { uploads } = await api('/api/ingest/presign', {
        files: toUpload.map((f) => ({ sha256: f.sha256, sizeBytes: f.sizeBytes })),
      });
      const urlFor = new Map<string, string>(
        (uploads as Array<{ sha256: string; url: string }>).map((u) => [u.sha256, u.url]),
      );

      await Promise.all(toUpload.map((f) => limit(async () => {
        const res = await fetch(urlFor.get(f.sha256)!, {
          method: 'PUT',
          body: createReadStream(f.path) as unknown as BodyInit,
          // @ts-expect-error — Node requires duplex for a stream body
          duplex: 'half',
        });
        if (!res.ok) throw new Error(`upload ${f.filename} -> ${res.status}`);
        uploaded++;
        process.stdout.write(`\r  uploading ...... ${uploaded}/${toUpload.length}`);
      })));
      process.stdout.write('\n');
    }

    await api('/api/ingest/complete', {
      files: group.map((f) => ({ sha256: f.sha256, sizeBytes: f.sizeBytes, filename: f.filename })),
    });
  }

  console.log(`\n  ✓ ${uploaded} uploaded, ${deduped} already stored`);
}

main().catch((err) => { console.error('\n' + err.message); process.exit(1); });
