import { issueSignedToken, presignUrl, head, BlobNotFoundError } from '@vercel/blob';

export interface DiskStore {
  uploadUrl(sha256: string, sizeBytes: number): Promise<{ url: string; expiresAt: Date }>;
  downloadUrl(sha256: string, ttlSeconds: number): Promise<string>;
  exists(sha256: string): Promise<boolean>;
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

  async exists(sha256) {
    assertSha(sha256);
    try {
      await head(key(sha256));
      return true;
    } catch (err) {
      // head() THROWS when absent; it does not return null.
      if (err instanceof BlobNotFoundError) return false;
      throw err;
    }
  },
};
