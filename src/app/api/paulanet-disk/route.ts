import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { contentDisposition } from '@/lib/download-name';
import { PAULANET_DISK_SHA256 } from '@/lib/paulanet-disk';

// Reads ~880 KB out of Blob storage and streams it back.
export const maxDuration = 60;

/**
 * The PaulaNET driver disk for a person (spec 2026-10-12 §2 "Also downloadable"), for a real floppy or an
 * emulator. Signed-in users only, like every download here. Streamed, never a presigned redirect (the rule in
 * ../disks/[id]/adf/route.ts). Rob's files on it are his, by permission (third-party/paulanet/).
 */
export async function GET() {
  await requireOrg();
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
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}
