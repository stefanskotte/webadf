import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Self-hosting P2 (spec D7). Each failure says what is wrong and what fixes it. */
export type CheckResult = { level: 'ok' | 'warn' | 'fail'; message: string };
export const GB = 1024 ** 3;
const ok = (message = ''): CheckResult => ({ level: 'ok', message });

export function checkFreeSpace(freeBytes: number, label: string): CheckResult {
  const gb = (freeBytes / GB).toFixed(1);
  if (freeBytes < GB) return { level: 'fail', message: `only ${gb} GB free on ${label}: webadf needs at least 1 GB (disk images are 880 KB each, plus their history) -- free space or set WEBADF_DATA_DIR to a bigger disk` };
  if (freeBytes < 5 * GB) return { level: 'warn', message: `${gb} GB free on ${label}: fine for now, but a big library with history wants more` };
  return ok();
}

export function checkWritable(dir: string, label: string): CheckResult {
  const probe = join(dir, `.webadf-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
    return ok();
  } catch {
    const uid = process.getuid?.() ?? 1000;
    return { level: 'fail', message: `${label} is not writable by uid ${uid}: run sudo chown -R 1000:1000 "$WEBADF_DATA_DIR/${label}"` };
  }
}

/**
 * entries = names in data/postgres. The Postgres 18 image keeps its cluster in data/postgres/18/; anything else
 * there (another major's folder, a pre-18 data/ folder, or a cluster mounted straight at data/postgres) is a
 * cluster this image would not see, and starting would put an empty one beside it.
 */
export function checkPgData(entries: string[]): CheckResult {
  const names = entries.filter((e) => !e.startsWith('.'));
  if (names.length === 0 || names.includes('18')) return ok();
  const major = names.find((e) => /^\d+$/.test(e));
  const what = major ? `a Postgres ${major} cluster this image cannot use (the image is Postgres 18)` : 'a Postgres cluster this image cannot use (no 18/ folder; the image is Postgres 18)';
  return { level: 'fail', message: `data/postgres holds ${what} -- see docs/self-hosting.md, "Postgres major upgrade" (it is never upgraded automatically)` };
}
