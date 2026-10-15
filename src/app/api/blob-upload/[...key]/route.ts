import { backend } from '@/lib/storage/select';
import { BlobExistsError, assertKey } from '@/lib/storage/backend';
import { verifyUpload } from '@/lib/storage/upload-sig';

/**
 * Where a browser or the CLI PUTs a disk image when storage is local (P1 D9).
 * Authorised by the URL's signature alone, like a presigned Blob URL. Answers
 * exactly as Vercel Blob does where the client cares: 403 = expired or bad
 * (the dropzone re-presigns once), 400 "This blob already exists" = already stored.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const b = backend();
  if (b.label !== 'Local disk') return new Response('not found', { status: 404 });
  const key = (await ctx.params).key.join('/');
  try { assertKey(key); } catch { return new Response('bad key', { status: 403 }); }
  const v = verifyUpload(key, new URL(req.url).searchParams);
  if (!v.ok) return new Response('expired or invalid upload URL', { status: 403 });
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > v.max) return new Response('too large', { status: 413 });
  if (!req.body) return new Response('empty body', { status: 400 });

  let seen = 0;
  let over = false;
  const limited = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      seen += chunk.byteLength;
      if (seen > v.max) { over = true; c.error(new Error('too large')); return; }
      c.enqueue(chunk);
    },
  }));
  try {
    await b.put(key, limited, { contentType: 'application/octet-stream', overwrite: false });
    return new Response(null, { status: 200 });
  } catch (e) {
    if (over) return new Response('too large', { status: 413 });
    if (e instanceof BlobExistsError) return new Response('This blob already exists', { status: 400 });
    throw e;
  }
}
