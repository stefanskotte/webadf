import { BlobExistsError } from './backend';
import { backend, storageLabel } from './select';

/**
 * The app's file stores, all on one BlobBackend (backend.ts): Vercel Blob in
 * production, a local directory for a self-hoster (select.ts chooses). No
 * store imports a storage SDK; vercel-blob.ts is the only @vercel/blob user.
 */

/** What the About page names as file storage (spec D5: the kind, never the store's URL or token). */
export { storageLabel };

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
  put(sha256: string, bytes: Uint8Array, opts?: { overwrite?: boolean }): Promise<{ key: string }>;
  /** Metadata for a stored blob, or null when it is absent. */
  stat(sha256: string): Promise<BlobStat | null>;
  /** Full contents. Only ever called for a blob whose digest still has to be verified. */
  read(sha256: string): Promise<Uint8Array>;
  /** Bytes offset..offset+length-1 (clamped at the end); throws when absent. For the board's file chunks. */
  readRange(sha256: string, offset: number, length: number): Promise<Uint8Array>;
  /** Frees the key so a later, correct upload can claim it. */
  remove(sha256: string): Promise<void>;
  /**
   * Every object under adf/ whose name is a sha-256, with its upload time.
   * Only the weekly blob GC (blob-gc-run.ts) lists the store: it is the one
   * caller that has to see bytes no database row names any more.
   */
  listAll(): Promise<{ sha256: string; uploadedAt: Date }[]>;
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

/** Content-addressed disk images at adf/<sha256>. */
export const diskStore: DiskStore = {
  async put(sha256, bytes, opts) {
    assertSha(sha256);
    const pathname = key(sha256);
    try {
      // overwrite: the caller has hashed what the key holds and found other bytes there (storeSendBytes).
      await backend().put(pathname, bytes, { contentType: 'application/octet-stream', overwrite: opts?.overwrite ?? false });
      return { key: pathname };
    } catch (err) {
      // Already in the store without its row -- a crash between the two
      // writes. Content-addressed, so the object that is there IS these
      // bytes; refusing forever would strand the digest. Same reconciliation
      // the upload path already does (the Vercel backend recognises "already
      // exists" via the shared isBlobAlreadyExists rule).
      if (!(err instanceof BlobExistsError)) throw err;
      return { key: pathname };
    }
  },

  storageKey: key,

  async uploadUrl(sha256, sizeBytes) {
    assertSha(sha256);
    return backend().uploadUrl(key(sha256), { maxBytes: sizeBytes, ttlMs: UPLOAD_TTL_MS });
  },

  async stat(sha256) {
    assertSha(sha256);
    // The size the store really holds. Callers compare it to whatever the
    // client claimed — the claim is never trusted on its own. null when absent.
    const meta = await backend().head(key(sha256));
    return meta ? { sizeBytes: meta.sizeBytes } : null;
  },

  async readRange(sha256, offset, length) {
    assertSha(sha256);
    const b = await backend().getRange(key(sha256), offset, offset + length - 1);
    if (!b) throw new Error(`storage: ${key(sha256)} is missing`);
    return b;
  },

  async read(sha256) {
    assertSha(sha256);
    // Uncached (the backend's default), and that is REQUIRED here. This read
    // exists to verify that the bytes at adf/<sha> really hash to <sha>, and a
    // CDN-cached copy could answer with something other than what origin
    // storage now holds — which is precisely the thing being checked.
    const result = await backend().get(key(sha256));
    if (!result) {
      throw new Error(`storage: could not read ${key(sha256)} back for verification`);
    }
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  },

  async remove(sha256) {
    assertSha(sha256);
    await backend().del(key(sha256));
  },

  async listAll() {
    const out: { sha256: string; uploadedAt: Date }[] = [];
    for await (const b of backend().list('adf/')) {
      const sha256 = b.key.slice('adf/'.length);
      // Anything not named by a digest is not ours to judge: skipped, never deleted.
      if (SHA256_RE.test(sha256)) out.push({ sha256, uploadedAt: b.uploadedAt });
    }
    return out;
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
 * A SECOND store rather than a second @vercel/blob importer: the BlobBackend
 * (backend.ts) is the seam a filesystem or MinIO backend is written against,
 * and a direct `put` in openretro-images.ts would put a second, undocumented
 * dependency behind that seam.
 *
 * It cannot simply be DiskStore: that interface is sha-256 shaped (assertSha
 * rejects a 40-character digest) and its keys live under adf/.
 *
 * These are stored PRIVATE, like everything else here (vercel-blob.ts says
 * why public was refused). They are served by /api/images/<sha1>, which
 * streams the bytes so no presigned URL ever reaches the DOM.
 */
export const imageStore: ImageStore = {
  storageKey: imageKey,

  async put(sha1, bytes, contentType) {
    if (!SHA1_RE.test(sha1)) {
      throw new Error(`storage: expected a lowercase hex sha-1 digest, got ${JSON.stringify(sha1)}`);
    }
    const pathname = imageKey(sha1);
    try {
      await backend().put(pathname, bytes, { contentType, overwrite: false });
      return { key: pathname };
    } catch (err) {
      // The object is already in the store but its row is not in the
      // database -- a crash between the two writes. Without this branch the
      // put is refused forever and that image retries every single sweep.
      // Exactly the reconciliation ADF uploads already do; the Vercel backend
      // turns its "already exists" into BlobExistsError via the one shared
      // isBlobAlreadyExists rule.
      if (!(err instanceof BlobExistsError)) throw err;
      return { key: pathname };
    }
  },

  async read(sha1) {
    if (!SHA1_RE.test(sha1)) return null;
    // cached: content-addressed by the image's own digest, so a cached copy
    // is these bytes; this read never verified anything and always used the cache.
    const result = await backend().get(imageKey(sha1), { cached: true });
    if (!result) return null;
    return {
      bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()),
      contentType: result.contentType ?? 'image/png',
    };
  },

  async remove(sha1) {
    await backend().del(imageKey(sha1));
  },
};

// ---------------------------------------------------------------- Title covers
/**
 * A cover image a PERSON chose for one of their titles (games.cover_override_sha256).
 *
 * Same Blob store as imageStore, its own namespace: cover/<sha256 of the
 * bytes>. Not imageStore itself, because those keys are OpenRetro's sha-1 (or
 * a Demozoo URL's), name third-party images every tenant may see, and are
 * served unauthenticated by /api/images. These are tenant content: served
 * only by /api/games/<id>/cover/<sha256> after an org check, and reclaimed by
 * the weekly blob GC once no title names them (blob-gc-run.ts).
 *
 * Content-addressed, so two titles (in any orgs) choosing the same bytes share
 * one object. That is safe because an object here is never changed, only
 * written once and eventually deleted when NOTHING names it -- the rule the
 * GC already applies to adf/.
 */
export interface CoverStore {
  put(sha256: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }>;
  read(sha256: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  remove(sha256: string): Promise<void>;
  /** Every object under cover/ named by a sha-256. Only the blob GC lists. */
  listAll(): Promise<{ sha256: string; uploadedAt: Date }[]>;
  storageKey(sha256: string): string;
}

const coverKey = (sha256: string) => `cover/${sha256}`;

export const coverStore: CoverStore = {
  storageKey: coverKey,

  async put(sha256, bytes, contentType) {
    assertSha(sha256);
    const pathname = coverKey(sha256);
    // overwrite: TRUE, unlike adf/ and oagd/: two titles may choose the
    // same bytes, so the object can already exist and a re-put must not fail.
    // Nothing relies on an overwrite refreshing the upload time; the blob GC
    // re-checks the references just before it deletes (blob-gc-run.ts).
    await backend().put(pathname, bytes, { contentType, overwrite: true });
    return { key: pathname };
  },

  async read(sha256) {
    if (!SHA256_RE.test(sha256)) return null;
    // cached, as imageStore.read: content-addressed, so a cached copy is these bytes.
    const result = await backend().get(coverKey(sha256), { cached: true });
    if (!result) return null;
    return {
      bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()),
      contentType: result.contentType ?? 'application/octet-stream',
    };
  },

  async remove(sha256) {
    assertSha(sha256);
    await backend().del(coverKey(sha256));
  },

  async listAll() {
    const out: { sha256: string; uploadedAt: Date }[] = [];
    for await (const b of backend().list('cover/')) {
      const sha256 = b.key.slice('cover/'.length);
      if (SHA256_RE.test(sha256)) out.push({ sha256, uploadedAt: b.uploadedAt });
    }
    return out;
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
    await backend().put(demozooKey(name), body, {
      contentType: demozooContentType(name), overwrite: true, multipart: true,
    });
  },
  async putBytes(name, bytes) {
    await backend().put(demozooKey(name), bytes, {
      contentType: demozooContentType(name), overwrite: true, multipart: true,
    });
  },
  async readStream(name) {
    // Uncached: the two keys are overwritten every import.
    const result = await backend().get(demozooKey(name));
    return result ? result.stream : null;
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
 * Here rather than in the route, so the route and the publish script go
 * through the same backend as every other store.
 */
export const firmwareStore = {
  async read(blobPath: string): Promise<Uint8Array | null> {
    // Uncached, for the same reason diskStore.read gives.
    //
    // The key is a VERSION, not a digest, so the bytes behind it are not
    // immutable by construction: the e2e fixture overwrites and deletes the
    // same path, and a publish could be corrected. A cached MISS is the one
    // that actually bit -- it outlived a deleted object and made the route
    // answer 503 for a release whose row and bytes both existed, which reads
    // as "the store is down" rather than "you are being served a stale
    // answer". Diagnosed by this exact failure.
    const result = await backend().get(blobPath);
    if (!result) return null;
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
    const result = await backend().get(blobPath);
    if (!result) return null;
    // The size of THESE bytes, not the size a database row remembers. The key
    // is a version rather than a digest, so the object behind it is not
    // immutable by construction (this module's own note says a publish could
    // be corrected) -- and a content-length that disagrees with the body is a
    // truncated download the board would then fail to verify. (The Vercel
    // backend reads it from the response's content-length; local disk from
    // the file it is about to stream.)
    return { stream: result.stream, sizeBytes: result.sizeBytes };
  },

  /** Metadata for a stored image, or null when absent. The publish script checks before it uploads. */
  async stat(blobPath: string): Promise<{ sizeBytes: number } | null> {
    const meta = await backend().head(blobPath);
    return meta ? { sizeBytes: meta.sizeBytes } : null;
  },

  /**
   * Stores an image. Overwrites by default: the e2e fixture re-seeds the same
   * path on every run. The publish script passes overwrite: false -- a real
   * release is never silently replaced.
   */
  async put(blobPath: string, bytes: Uint8Array, opts: { overwrite?: boolean } = {}): Promise<void> {
    await backend().put(blobPath, bytes, {
      contentType: 'application/octet-stream', overwrite: opts.overwrite ?? true,
    });
  },

  /** Removes an image; absent is not an error. Only the e2e teardown removes firmware. */
  async remove(blobPath: string): Promise<void> {
    await backend().del(blobPath);
  },
};
