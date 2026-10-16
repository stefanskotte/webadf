import { mkdirSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The postgres image's entrypoint (root) creates <mount>/18 with the mode it inherits, then drops to uid 999 and
 * must traverse <mount> and <mount>/18. A data folder whose default ACL gives new directories no execute bit for
 * "other" (OpenMediaVault shared folders) makes that fail in a restart loop. An explicit chmod overrides the
 * inherited bits. Nothing inside 18/ is touched: postgres owns 18/docker (0700).
 */
export function preparePgDir(pgDir: string): void {
  const major = join(pgDir, '18');
  mkdirSync(major, { recursive: true });
  chmodSync(pgDir, 0o755);
  chmodSync(major, 0o755);
}

/** Add the execute bits (u+x,g+x,o+x) to the data root, nothing else: postgres must be able to traverse it. */
export function ensureTraversable(dir: string): void {
  const mode = statSync(dir).mode & 0o7777;
  if ((mode & 0o111) !== 0o111) chmodSync(dir, mode | 0o111);
}
