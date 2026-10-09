import { requireOrg } from '@/lib/session';
import { coverStore } from '@/lib/storage';
import { isCoverDigest } from '@/lib/cover-image';
import { getCoverOverride } from '@/lib/cover-override';

/**
 * Serve title [id]'s own cover.
 *
 * Streamed, like /api/images, so no presigned URL ever reaches the DOM. Unlike
 * /api/images it is AUTHENTICATED and org-checked: these are a tenant's own
 * uploads. The digest must be the one this org's title names RIGHT NOW --
 * knowing a digest (another org's, or this title's previous cover) is not
 * enough to fetch the bytes.
 *
 * Cached `private` (never by a shared cache, since it is per-session) but
 * immutable: the digest is in the path, so a changed cover is a new URL.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string; sha256: string }> },
) {
  const { orgId } = await requireOrg();
  const { id, sha256 } = await ctx.params;
  if (!isCoverDigest(sha256)) return Response.json({ error: 'bad_digest' }, { status: 400 });

  const current = await getCoverOverride(orgId, id);
  if (!current || current.sha256 !== sha256) return Response.json({ error: 'not_found' }, { status: 404 });

  const image = await coverStore.read(sha256);
  if (!image) return Response.json({ error: 'not_found' }, { status: 404 });

  return new Response(image.bytes as unknown as BodyInit, {
    headers: {
      'content-type': image.contentType,
      'content-length': String(image.bytes.byteLength),
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      // An image response needs no script, style or frame; say so in case a
      // browser is ever talked into rendering one as a document.
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}
