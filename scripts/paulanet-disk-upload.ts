/**
 * Puts the PaulaNET driver disk into the disk store, once. Usage:
 *   tools/paulanet-disk/build.sh /tmp/PaulaNET.adf
 *   pnpm exec dotenv -e .env.local -- tsx scripts/paulanet-disk-upload.ts /tmp/PaulaNET.adf
 * Refuses bytes that are not the pinned disk; does nothing when the store already holds them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { diskStore } from '@/lib/storage';
import { PAULANET_DISK_SHA256, PAULANET_DISK_BYTES } from '@/lib/paulanet-disk';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: paulanet-disk-upload.ts <PaulaNET.adf>');
  const bytes = readFileSync(path);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== PAULANET_DISK_SHA256 || bytes.length !== PAULANET_DISK_BYTES) {
    throw new Error(`${path} is ${sha} (${bytes.length} B), not the pinned disk ${PAULANET_DISK_SHA256}`);
  }
  const have = await diskStore.stat(sha);
  if (have) { console.log(`already stored: ${diskStore.storageKey(sha)} (${have.sizeBytes} B)`); return; }
  const { key } = await diskStore.put(sha, new Uint8Array(bytes));
  const check = await diskStore.read(sha);
  const back = createHash('sha256').update(check).digest('hex');
  if (back !== sha) throw new Error(`read back ${back}, not ${sha}`);
  console.log(`stored ${key}, read back and verified`);
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
