import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Self-hosting P3 D5: the image carries the sha-pinned PaulaNET disk; first start stores it once. */
export async function ensurePaulanetDisk(opts: {
  adfPath: string; expectedSha256: string;
  has: (sha: string) => Promise<boolean>; put: (sha: string, bytes: Buffer) => Promise<void>; log?: (l: string) => void;
}): Promise<'stored' | 'present'> {
  if (await opts.has(opts.expectedSha256)) return 'present';
  const bytes = await readFile(opts.adfPath);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== opts.expectedSha256) throw new Error(`${opts.adfPath} is not the pinned PaulaNET disk (${sha})`);
  await opts.put(sha, bytes);
  opts.log?.('PaulaNET driver disk stored');
  return 'stored';
}
