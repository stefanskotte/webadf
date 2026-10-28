import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { authorizeShare, notFound, shareBody, shareJson, withShare } from '@/lib/share/api';
import { diskInScope } from '@/lib/share/scope';
import { diskStore } from '@/lib/storage';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The disk image. The scope check runs NOW, on every request (Review Focus 1): a title taken out of a shared
 * collection 404s here even if the recipient listed it a moment ago. For this route the scope check replaces the
 * entitlements gate -- the owner chose to distribute (spec §3.2).
 */
export const GET = withShare(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await authorizeShare(req, 'bytes');
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const disk = await diskInScope(auth, id);
  if (!disk) return notFound();
  if (disk.sizeBytes > MAX_DISK_BYTES) return shareJson({ error: 'unavailable' }, 503);

  let bytes: Uint8Array;
  try { bytes = await diskStore.read(disk.sha256); } catch { return shareJson({ error: 'unavailable' }, 503); }
  if (bytes.byteLength > MAX_DISK_BYTES) return shareJson({ error: 'unavailable' }, 503);
  return shareBody(bytes, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(bytes.byteLength),
    ETag: `"${disk.sha256}"`,
    'X-Content-Type-Options': 'nosniff',
  });
});
