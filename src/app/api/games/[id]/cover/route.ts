import { createHash } from 'node:crypto';
import { requireOrg } from '@/lib/session';
import { coverStore } from '@/lib/storage';
import { checkCoverImage, coverOverrideUrl, MAX_COVER_BYTES } from '@/lib/cover-image';
import { stripImageMetadata } from '@/lib/cover-strip';
import { getCoverOverride, setCoverOverride } from '@/lib/cover-override';

/**
 * Read at most `max` bytes of the request body. Returns null as soon as the
 * body goes past the cap, so a client that lies about (or omits)
 * Content-Length still cannot make the function buffer more than the cap.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * Set title [id]'s own cover. The body is the raw image file (what
 * `fetch(url, { method: 'PUT', body: file })` sends) -- no multipart, so
 * nothing but the bytes is parsed.
 *
 * The browser's Content-Type and the file's name are ignored: the type that is
 * stored and later served is the one the bytes' own header declares
 * (checkCoverImage). Stored as uploaded, not re-encoded -- there is no image
 * library in this app, and a validated raster served with nosniff from a
 * private, org-checked route is not executable.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
    return Response.json({ error: 'too_large', detail: 'Images can be at most 2 MB.' }, { status: 413 });
  }

  // 404 before reading the body or touching the store: a title of another org
  // (or none) must cost nothing and reveal nothing.
  if (!(await getCoverOverride(orgId, id))) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  const bytes = await readCapped(request, MAX_COVER_BYTES);
  if (!bytes) {
    return Response.json({ error: 'too_large', detail: 'Images can be at most 2 MB.' }, { status: 413 });
  }
  const check = checkCoverImage(bytes);
  if (!check.ok) {
    return Response.json({ error: check.error, detail: check.detail },
      { status: check.error === 'too_large' ? 413 : check.error === 'empty' ? 400 : 415 });
  }

  // Store (and name by digest) what is served: the image without its Exif/XMP
  // metadata, which a phone photo fills with the place it was taken.
  const stored = stripImageMetadata(bytes);
  const image = checkCoverImage(stored);
  if (!image.ok) {
    return Response.json({ error: image.error, detail: image.detail }, { status: 415 });
  }
  const sha256 = createHash('sha256').update(stored).digest('hex');
  // Bytes first, then the row: a crash between the two leaves an object
  // nothing names, which the blob GC reclaims; the reverse order would leave
  // a title naming bytes that are not there.
  await coverStore.put(sha256, stored, image.image.type);
  if (!(await setCoverOverride(orgId, id, sha256))) {
    // Deleted between the check and now. The object is left for the GC.
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return Response.json({ url: coverOverrideUrl(id, sha256), ...image.image });
}

/** "Revert to default": forget the title's own cover. The stored object stays for the GC. */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  if (!(await setCoverOverride(orgId, id, null))) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
