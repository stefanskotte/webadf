import {
  issueSignedToken, presignUrl, head, get, put, del, BlobNotFoundError,
} from '@vercel/blob';
import { isBlobAlreadyExists } from '@/lib/blob-upload';

export interface BlobStat {
  /** The size the store actually holds, in bytes. Authoritative — never the client's claim. */
  sizeBytes: number;
}

export interface DiskStore {
  uploadUrl(sha256: string, sizeBytes: number): Promise<{ url: string; expiresAt: Date }>;
  /**
   * Stores bytes directly, for a disk this SERVER built rather than one a
   * browser uploaded. The presigned-PUT path above exists so large uploads
   * never pass through a function; a formatted blank disk is already in
   * memory here, and round-tripping it out to a presigned URL and back would
   * add a network hop to move bytes to themselves.
   */
  put(sha256: string, bytes: Uint8Array): Promise<{ key: string }>;
  downloadUrl(sha256: string, ttlSeconds: number): Promise<string>;
  /** Metadata for a stored blob, or null when it is absent. */
  stat(sha256: string): Promise<BlobStat | null>;
  /** Full contents. Only ever called for a blob whose digest still has to be verified. */
  read(sha256: string): Promise<Uint8Array>;
  /** Frees the key so a later, correct upload can claim it. */
  remove(sha256: string): Promise<void>;
  storageKey(sha256: string): string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const UPLOAD_TTL_MS = 60 * 60 * 1000;

function assertSha(sha256: string): void {
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`storage: expected a lowercase hex sha-256 digest, got ${JSON.stringify(sha256)}`);
  }
}

function key(sha256: string): string {
  return `adf/${sha256}`;
}

/**
 * Vercel Blob implementation. The ONLY file that may import @vercel/blob —
 * swapping to R2 or a self-hosted S3 means writing another DiskStore here.
 */
export const diskStore: DiskStore = {
  async put(sha256, bytes) {
    assertSha(sha256);
    const pathname = key(sha256);
    try {
      // Buffer.from wraps the same memory; the SDK's PutBody does not accept
      // a bare Uint8Array.
      await put(pathname, Buffer.from(bytes), {
        access: 'private', contentType: 'application/octet-stream',
        addRandomSuffix: false, allowOverwrite: false,
      });
      return { key: pathname };
    } catch (err) {
      // Already in the store without its row -- a crash between the two
      // writes. Content-addressed, so the object that is there IS these
      // bytes; refusing forever would strand the digest. Same reconciliation
      // the upload path already does, via the same shared rule.
      const message = err instanceof Error ? err.message : String(err);
      if (!isBlobAlreadyExists(400, message)) throw err;
      return { key: pathname };
    }
  },

  storageKey: key,

  async uploadUrl(sha256, sizeBytes) {
    assertSha(sha256);
    const pathname = key(sha256);
    const validUntil = Date.now() + UPLOAD_TTL_MS;

    const token = await issueSignedToken({
      pathname,
      operations: ['put'],
      maximumSizeInBytes: sizeBytes,
      validUntil,
    });

    // presignUrl needs BOTH tokens, and returns { presignedUrl } — not a string.
    // addRandomSuffix/allowOverwrite are only signed into the URL when passed
    // explicitly, so always pass them.
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put',
      pathname,
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
    });

    return { url: presignedUrl, expiresAt: new Date(validUntil) };
  },

  async downloadUrl(sha256, ttlSeconds) {
    assertSha(sha256);
    const pathname = key(sha256);
    const validUntil = Date.now() + ttlSeconds * 1000;

    const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(token, {
      operation: 'get',
      pathname,
      access: 'private',
      validUntil,
    });

    // Carries its delegation and signature as query params: a bare HTTPS GET
    // with no headers and no SDK works. This is the ESP32 fetch path.
    return presignedUrl;
  },

  async stat(sha256) {
    assertSha(sha256);
    try {
      // head() returns the size the store really holds. Callers compare it to
      // whatever the client claimed — the claim is never trusted on its own.
      const meta = await head(key(sha256));
      return { sizeBytes: meta.size };
    } catch (err) {
      // head() THROWS when absent; it does not return null.
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
  },

  async read(sha256) {
    assertSha(sha256);
    // useCache: false is REQUIRED here. This read exists to verify that the
    // bytes at adf/<sha> really hash to <sha>, and a CDN-cached copy could
    // answer with something other than what origin storage now holds — which
    // is precisely the thing being checked.
    const result = await get(key(sha256), { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) {
      throw new Error(`storage: could not read ${key(sha256)} back for verification`);
    }
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  },

  async remove(sha256) {
    assertSha(sha256);
    await del(key(sha256));
  },
};

const SHA1_RE = /^[0-9a-f]{40}$/;

function imageKey(sha1: string): string {
  return `oagd/${sha1}`;
}

export interface ImageStore {
  /** Stores bytes at oagd/<sha1>. */
  put(sha1: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }>;
  /** Full contents, for the route that streams them to a browser. */
  read(sha1: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Only the e2e suite removes an image; the app never deletes one. */
  remove(sha1: string): Promise<void>;
  storageKey(sha1: string): string;
}

/**
 * Cover art and screenshots, keyed by OpenRetro's own sha-1.
 *
 * A SECOND store rather than a second @vercel/blob importer. This file states
 * that it is the only place that may import the SDK, and the self-hosting
 * backlog item treats DiskStore as the seam a MinIO or filesystem backend
 * would be written against -- a direct `put` in openretro-images.ts would put
 * a second, undocumented dependency behind that seam.
 *
 * It cannot simply be DiskStore: that interface is sha-256 shaped (assertSha
 * rejects a 40-character digest) and its keys live under adf/.
 *
 * These are stored PRIVATE, like everything else here. access: 'public' was
 * tried first and the real store refused it outright -- "Cannot use public
 * access on a private store" -- and making the store public to suit cover art
 * would also make every ADF in it publicly addressable, which is precisely
 * the boundary /api/device/image exists to enforce. They are served instead
 * by /api/images/<sha1>, which streams the bytes so no presigned URL ever
 * reaches the DOM.
 */
export const imageStore: ImageStore = {
  storageKey: imageKey,

  async put(sha1, bytes, contentType) {
    if (!SHA1_RE.test(sha1)) {
      throw new Error(`storage: expected a lowercase hex sha-1 digest, got ${JSON.stringify(sha1)}`);
    }
    const pathname = imageKey(sha1);
    try {
      // Buffer.from wraps the same memory; the SDK's PutBody does not accept
      // a bare Uint8Array.
      await put(pathname, Buffer.from(bytes), {
        access: 'private', contentType, addRandomSuffix: false, allowOverwrite: false,
      });
      return { key: pathname };
    } catch (err) {
      // The object is already in the store but its row is not in the
      // database -- a crash between the two writes. Without this branch the
      // put is refused forever and that image retries every single sweep.
      // Exactly the reconciliation ADF uploads already do; isBlobAlreadyExists
      // is imported rather than re-expressed so there is one copy of the rule.
      // 400 is passed literally because the SDK throws an Error and does not
      // surface the status code that the presigned-PUT path can read.
      const message = err instanceof Error ? err.message : String(err);
      if (!isBlobAlreadyExists(400, message)) throw err;
      return { key: pathname };
    }
  },

  async read(sha1) {
    if (!SHA1_RE.test(sha1)) return null;
    const result = await get(imageKey(sha1), { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    return {
      bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()),
      contentType: result.headers.get('content-type') ?? 'image/png',
    };
  },

  async remove(sha1) {
    await del(imageKey(sha1));
  },
};

// ---------------------------------------------------------------- Demozoo export
/**
 * Our own copy of Demozoo's weekly export, and the Amiga extract made from it.
 * Two fixed keys, overwritten each import. Streamed both ways: the export is
 * ~200 MB gzipped and nothing here may buffer it whole. Retries of a failed
 * import read THIS copy, so Demozoo is never asked twice for one export.
 */
export type DemozooExportName = 'export.sql.gz' | 'amiga.json';

export interface DemozooExportStore {
  putStream(name: DemozooExportName, body: ReadableStream<Uint8Array>): Promise<void>;
  putBytes(name: DemozooExportName, bytes: Uint8Array): Promise<void>;
  readStream(name: DemozooExportName): Promise<ReadableStream<Uint8Array> | null>;
}

const demozooKey = (name: DemozooExportName) => `demozoo/${name}`;
const demozooContentType = (name: DemozooExportName) =>
  name === 'amiga.json' ? 'application/json' : 'application/gzip';

export const demozooExportStore: DemozooExportStore = {
  async putStream(name, body) {
    await put(demozooKey(name), body, {
      access: 'private', contentType: demozooContentType(name),
      addRandomSuffix: false, allowOverwrite: true, multipart: true,
    });
  },
  async putBytes(name, bytes) {
    await put(demozooKey(name), Buffer.from(bytes), {
      access: 'private', contentType: demozooContentType(name),
      addRandomSuffix: false, allowOverwrite: true, multipart: true,
    });
  },
  async readStream(name) {
    const result = await get(demozooKey(name), { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return result.stream;
  },
};

/**
 * Firmware images.
 *
 * Separate from diskStore because both the key space and the entitlement
 * model differ: the key is a version string rather than a digest, and
 * firmware is a product artifact every paired device may fetch, where a disk
 * belongs to one org.
 *
 * Here rather than in the route, for the reason stated above diskStore: this
 * is the only module that may import @vercel/blob.
 */
export const firmwareStore = {
  async read(blobPath: string): Promise<Uint8Array | null> {
    // useCache: false, for the same reason diskStore.read gives.
    //
    // The key is a VERSION, not a digest, so the bytes behind it are not
    // immutable by construction: the e2e fixture overwrites and deletes the
    // same path, and a publish could be corrected. A cached MISS is the one
    // that actually bit -- it outlived a deleted object and made the route
    // answer 503 for a release whose row and bytes both existed, which reads
    // as "the store is down" rather than "you are being served a stale
    // answer". Diagnosed by this exact failure.
    const result = await get(blobPath, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  },

  /**
   * The same read, handed straight to the response. Constant memory whatever
   * the image size or the concurrency -- which matters because a fleet-wide
   * update releases every targeted board's poll in the same tick, so the
   * downloads arrive together.
   */
  async readStream(
    blobPath: string,
  ): Promise<{ stream: ReadableStream; sizeBytes: number | null } | null> {
    const result = await get(blobPath, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return null;
    // The size of THESE bytes, not the size a database row remembers. The key
    // is a version rather than a digest, so the object behind it is not
    // immutable by construction (this module's own note says a publish could
    // be corrected) -- and a content-length that disagrees with the body is a
    // truncated download the board would then fail to verify.
    const len = Number(result.headers?.get?.('content-length'));
    return { stream: result.stream, sizeBytes: Number.isFinite(len) && len > 0 ? len : null };
  },
};
