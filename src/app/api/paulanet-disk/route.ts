import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { contentDisposition } from '@/lib/download-name';
import { PAULANET_DISK_SHA256, isDriverDisk } from '@/lib/paulanet-disk';

// Reads ~880 KB out of Blob storage and streams it back.
export const maxDuration = 60;

// The default URL names no digest, so the cache must not outlive the disk (final review m6): a rebuilt driver disk ships
// with a new PAULANET_DISK_SHA256, and a year-long `immutable` would keep serving the old one. Revalidated on
// every use instead, against the digest as the ETag -- a browser holding this disk gets a 304 and no blob read.
const CACHE_CONTROL = 'private, no-cache';

/**
 * The PaulaNET driver disk for a person (spec 2026-10-12 §2 "Also downloadable"), for a real floppy or an
 * emulator. Signed-in users only, like every download here. Streamed, never a presigned redirect (the rule in
 * ../disks/[id]/adf/route.ts). Rob's files on it (his PaulaNET Config; our LZ4 build of his
 * PaulaNET.device) are by his permission (third-party/paulanet/).
 *
 * The current disk by default; `?sha256=` names any driver disk (R16: an older one is still
 * what a board whose Amiga is online holds), and any other digest is 404.
 */
export async function GET(request: Request) {
  await requireOrg();
  const sha256 = new URL(request.url).searchParams.get('sha256') ?? PAULANET_DISK_SHA256;
  if (!isDriverDisk(sha256)) return Response.json({ error: 'not_found' }, { status: 404 });
  const etag = `"${sha256}"`;
  const held = request.headers.get('if-none-match');
  if (held !== null && held.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': CACHE_CONTROL } });
  }
  let bytes: Uint8Array;
  try {
    bytes = await diskStore.read(sha256);
  } catch {
    return Response.json({ error: 'blob_unavailable' }, { status: 503 });
  }
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/x-amiga-disk-file',
      'content-length': String(bytes.byteLength),
      'content-disposition': contentDisposition('PaulaNET.adf'),
      'cache-control': CACHE_CONTROL,
      etag,
    },
  });
}
