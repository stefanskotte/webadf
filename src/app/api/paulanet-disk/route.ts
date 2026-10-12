import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { contentDisposition } from '@/lib/download-name';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

// Reads ~880 KB out of Blob storage and streams it back.
export const maxDuration = 60;

// The URL names no digest, so the cache must not outlive the disk (final review m6): a rebuilt driver disk ships
// with a new PAULANET_DISK_SHA256, and a year-long `immutable` would keep serving the old one. Revalidated on
// every use instead, against the digest as the ETag -- a browser holding this disk gets a 304 and no blob read.
const ETAG = `"${PAULANET_DISK_SHA256}"`;
const CACHE_CONTROL = 'private, no-cache';

/**
 * The PaulaNET driver disk for a person (spec 2026-10-12 §2 "Also downloadable"), for a real floppy or an
 * emulator. Signed-in users only, like every download here. Streamed, never a presigned redirect (the rule in
 * ../disks/[id]/adf/route.ts). Rob's files on it are his, by permission (third-party/paulanet/).
 */
export async function GET(request: Request) {
  await requireOrg();
  const held = request.headers.get('if-none-match');
  if (held !== null && held.split(',').some((t) => t.trim().replace(/^W\//, '') === ETAG)) {
    return new Response(null, { status: 304, headers: { etag: ETAG, 'cache-control': CACHE_CONTROL } });
  }
  let bytes: Uint8Array;
  try {
    bytes = await diskStore.read(PAULANET_DISK_SHA256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/x-amiga-disk-file',
      'content-length': String(bytes.byteLength),
      'content-disposition': contentDisposition('PaulaNET.adf'),
      'cache-control': CACHE_CONTROL,
      etag: ETAG,
    },
  });
}
