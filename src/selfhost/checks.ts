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

/** entries = names in data/postgres; hasLegacyPgVersion = data/postgres/data/PG_VERSION exists (pre-18 image layout). */
export function checkPgData(entries: string[], hasLegacyPgVersion: boolean): CheckResult {
  const majors = entries.filter((e) => /^\d+$/.test(e) && e !== '18');
  const found = majors[0] ?? (hasLegacyPgVersion ? 'pre-18' : null);
  if (found && !entries.includes('18')) {
    return { level: 'fail', message: `data/postgres holds a Postgres ${found} cluster but the image is Postgres 18 -- see docs/self-hosting.md, "Postgres major upgrade" (it is never upgraded automatically)` };
  }
  return ok();
}
