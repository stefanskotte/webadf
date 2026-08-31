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
  /** Stores bytes at oagd/<sha1>, returning the public URL to render from. */
  put(sha1: string, bytes: Uint8Array, contentType: string): Promise<{ url: string; key: string }>;
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
 * rejects a 40-character digest), its keys live under adf/, and its objects
 * are PRIVATE and served through presigned URLs with a TTL. These are public,
 * because a game page renders them in an <img> and re-presigning every
 * screenshot on every page view would be a round trip per image for content
 * that is not secret.
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
      const result = await put(pathname, Buffer.from(bytes), {
        access: 'public', contentType, addRandomSuffix: false, allowOverwrite: false,
      });
      return { url: result.url, key: pathname };
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
      const meta = await head(pathname);
      return { url: meta.url, key: pathname };
    }
  },
};
