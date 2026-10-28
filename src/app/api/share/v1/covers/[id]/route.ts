import { authorizeShare, notFound, shareBody } from '@/lib/share/api';
import { scopedCoverSource } from '@/lib/share/listing';
import { coverStore, imageStore } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/** Title [id]'s cover, only while the title is in scope; 404 when it has none. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorizeShare(req, 'list');
  if (auth instanceof Response) return auth;
  const { id } = await ctx.params;
  const src = await scopedCoverSource(auth, id);
  if (!src) return notFound();
  const image = src.store === 'cover' ? await coverStore.read(src.digest) : await imageStore.read(src.digest);
  if (!image) return notFound();
  return shareBody(image.bytes, {
    'Content-Type': image.contentType,
    'Content-Length': String(image.bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
    // Stored types come from uploads and third parties: never let one render as a document.
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
}
