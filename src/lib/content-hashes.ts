import { createHash } from 'node:crypto';
import { crc32 } from '@/lib/crc32';

/**
 * Every digest TOSEC matching needs, from one pass over bytes already in
 * memory. Server-side only: no client ever supplies these (design §7),
 * because writing an unverified hash to the shared `blobs` row would let one
 * uploader mislabel a disk for every tenant holding the same bytes.
 */
export function contentHashes(bytes: Uint8Array) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex'),
    md5: createHash('md5').update(bytes).digest('hex'),
    crc32: crc32(bytes),
  };
}
