/**
 * The seam every file store sits on (self-hosting P1, spec D6-D8).
 *
 * Two real implementations: Vercel Blob (production, vercel-blob.ts) and a
 * directory on local disk (self-hosting, local.ts), chosen by select.ts. The
 * stores in index.ts -- diskStore, imageStore, coverStore, demozooExportStore,
 * firmwareStore -- are written against this interface only.
 */

export interface StoredObject {
  stream: ReadableStream<Uint8Array>;
  /** null when the backend does not know it; each store applies its own default, as it always has. */
  contentType: string | null;
  /** The size of THESE bytes when the backend knows it, else null. */
  sizeBytes: number | null;
}

export interface PutOptions {
  contentType: string;
  /** false: refuse with BlobExistsError when the key is already taken. */
  overwrite: boolean;
  /**
   * Vercel Blob only: upload in parts. demozooExportStore always set it, for
   * bytes as well as streams; other backends ignore it.
   */
  multipart?: boolean;
}

export interface GetOptions {
  /**
   * Allow a CDN-cached answer. Off by default: most reads verify or serve
   * bytes whose key is not immutable. Only content-addressed images whose
   * keys never change meaning set it (imageStore, coverStore); backends
   * without a cache ignore it.
   */
  cached?: boolean;
}

export interface BlobBackend {
  /** 'Vercel Blob' | 'Local disk' -- what the About page names (spec D5: the kind, never a URL or token). */
  readonly label: string;
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts: PutOptions): Promise<void>;
  /** null when absent. Uncached unless opts.cached. */
  get(key: string, opts?: GetOptions): Promise<StoredObject | null>;
  head(key: string): Promise<{ sizeBytes: number; uploadedAt: Date } | null>;
  /** Idempotent: deleting an absent key is not an error. */
  del(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<{ key: string; uploadedAt: Date }>;
  uploadUrl(key: string, opts: { maxBytes: number; ttlMs: number }): Promise<{ url: string; expiresAt: Date }>;
}

/** A put with overwrite: false found the key already taken. */
export class BlobExistsError extends Error {
  constructor(key: string) {
    super(`storage: ${key} already exists`);
    this.name = 'BlobExistsError';
  }
}

// Lowercase, no leading separator. '+' is allowed because every production
// firmware key carries one (firmware/1.13.0+g290990b.bin). No segment may
// start with '.', so a key can never name local.ts's temp files (.tmp-*) or
// any other hidden file.
const KEY_RE = /^[a-z0-9][a-z0-9/._+-]*$/;

/**
 * Throws on a key that could escape the store or collide with the local
 * backend's own files (D8): '..', '//', a trailing '/', uppercase, an
 * absolute path, a segment starting with '.', and the '.meta.json' suffix
 * local.ts keeps sidecars under.
 */
export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//') || key.includes('/.') || key.endsWith('/') || key.endsWith('.meta.json')) {
    throw new Error(`storage: invalid key ${JSON.stringify(key)}`);
  }
}
