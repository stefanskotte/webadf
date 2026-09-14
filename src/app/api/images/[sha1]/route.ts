import { imageStore } from '@/lib/storage';

/**
 * Serve one stored OpenRetro image.
 *
 * The bytes are STREAMED rather than answered with a redirect to a presigned
 * URL. A presigned URL is a live credential -- the standing rule in this
 * repo is that one never reaches the DOM or a log -- and a 302 would hand one
 * to the browser on every page view.
 *
 * Deliberately UNAUTHENTICATED. These are third-party images that
 * openretro.org already serves to anyone at the same sha1, so a session check
 * would buy no confidentiality; what it would buy is a session lookup per
 * image on a page that shows a cover plus five screenshots. The boundary that
 * actually matters is the digest format below: constraining the parameter to
 * a 40-character sha-1 means this route can only ever address oagd/<sha1> and
 * can never be walked into adf/<sha256>, which IS tenant data and is guarded
 * by /api/device/image's entitlement check.
 */
const SHA1_RE = /^[0-9a-f]{40}$/;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ sha1: string }> },
) {
  const { sha1 } = await ctx.params;
  if (!SHA1_RE.test(sha1)) {
    return Response.json({ error: 'bad_digest' }, { status: 400 });
  }

  const image = await imageStore.read(sha1);
  if (!image) return Response.json({ error: 'not_found' }, { status: 404 });

  return new Response(image.bytes as unknown as BodyInit, {
    headers: {
      'content-type': image.contentType,
      'content-length': String(image.bytes.byteLength),
      // Content-addressed by sha-1: the bytes at this URL can never change,
      // so the browser never needs to ask again.
      'cache-control': 'public, max-age=31536000, immutable',
      // Stored content types come from third-party responses; never let a
      // browser second-guess one into something executable.
      'x-content-type-options': 'nosniff',
    },
  });
}
