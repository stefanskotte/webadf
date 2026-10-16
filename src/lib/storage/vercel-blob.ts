import {
  issueSignedToken, presignUrl, head, get, put, del, list, BlobNotFoundError,
} from '@vercel/blob';
import { isBlobAlreadyExists } from '@/lib/blob-upload';
import { assertKey, BlobExistsError, type BlobBackend } from './backend';

/**
 * Vercel Blob implementation -- production's store. The ONLY file that may
 * import @vercel/blob (besides the BlobServiceRateLimited checks in the ingest
 * route and ingest-complete.ts, an error only this backend can raise).
 * Swapping to R2 or a self-hosted S3 means writing another BlobBackend.
 *
 * Every object is PRIVATE. access: 'public' was tried first for cover art and
 * the real store refused it outright -- "Cannot use public access on a private
 * store" -- and making the store public would make every ADF in it publicly
 * addressable, which is precisely the boundary /api/device/image exists to
 * enforce. Bytes are served by routes that stream them, so no presigned URL
 * ever reaches the DOM.
 *
 * Constructing this does no I/O; only the calls below reach the network.
 */
export function vercelBlobBackend(): BlobBackend {
  return {
    label: 'Vercel Blob',

    async put(key, body, { contentType, overwrite, multipart }) {
      assertKey(key);
      try {
        // Buffer.from wraps the same memory; the SDK's PutBody does not accept
        // a bare Uint8Array.
        await put(key, body instanceof Uint8Array ? Buffer.from(body) : body, {
          access: 'private', contentType, addRandomSuffix: false, allowOverwrite: overwrite,
          ...(multipart ? { multipart: true } : {}),
        });
      } catch (err) {
        // The object is already in the store. The SDK throws an Error and does
        // not surface the status code the presigned-PUT path can read, so 400
        // is passed literally; isBlobAlreadyExists is imported rather than
        // re-expressed so there is one copy of the rule. Callers decide what
        // "already there" means (diskStore/imageStore reconcile it).
        const message = err instanceof Error ? err.message : String(err);
        if (!overwrite && isBlobAlreadyExists(400, message)) throw new BlobExistsError(key);
        throw err;
      }
    },

    async get(key, opts) {
      assertKey(key);
      // useCache: false unless the caller says otherwise: a CDN-cached copy
      // could answer with something other than what origin storage now holds
      // (see the stores' own notes on why each read needs origin). Only
      // content-addressed images pass cached: true, and for those the call is
      // exactly what it was before this backend existed.
      const result = opts?.cached
        ? await get(key, { access: 'private' })
        : await get(key, { access: 'private', useCache: false });
      if (!result || result.statusCode !== 200) return null;
      const len = Number(result.headers?.get?.('content-length'));
      return {
        stream: result.stream,
        contentType: result.headers?.get?.('content-type') ?? null,
        sizeBytes: Number.isFinite(len) && len > 0 ? len : null,
      };
    },

    async getRange(key, start, endInclusive) {
      assertKey(key);
      const result = await get(key, { access: 'private', useCache: false, headers: { range: `bytes=${start}-${endInclusive}` } });
      // The SDK types statusCode as 200 | 304, but a ranged read is answered 206 (verified only against the API's
      // documented HTTP behaviour; a 200 means the whole object came back and is sliced here).
      const status = (result as { statusCode: number } | null)?.statusCode;
      if (!result || !result.stream || (status !== 200 && status !== 206)) return null;
      const all = new Uint8Array(await new Response(result.stream).arrayBuffer());
      return status === 206 ? all : all.subarray(start, Math.min(endInclusive + 1, all.length));
    },

    async head(key) {
      assertKey(key);
      try {
        // head() returns the size the store really holds.
        const meta = await head(key);
        return { sizeBytes: meta.size, uploadedAt: new Date(meta.uploadedAt) };
      } catch (err) {
        // head() THROWS when absent; it does not return null.
        if (err instanceof BlobNotFoundError) return null;
        throw err;
      }
    },

    async del(key) {
      assertKey(key);
      await del(key);
    },

    async *list(prefix) {
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        for (const b of page.blobs) yield { key: b.pathname, uploadedAt: new Date(b.uploadedAt) };
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    },

    async uploadUrl(key, { maxBytes, ttlMs }) {
      assertKey(key);
      const validUntil = Date.now() + ttlMs;

      const token = await issueSignedToken({
        pathname: key,
        operations: ['put'],
        maximumSizeInBytes: maxBytes,
        validUntil,
      });

      // presignUrl needs BOTH tokens, and returns { presignedUrl } — not a string.
      // addRandomSuffix/allowOverwrite are only signed into the URL when passed
      // explicitly, so always pass them.
      const { presignedUrl } = await presignUrl(token, {
        operation: 'put',
        pathname: key,
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: false,
      });

      return { url: presignedUrl, expiresAt: new Date(validUntil) };
    },
  };
}
