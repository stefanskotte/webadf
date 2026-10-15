import { localBackend } from './local';
import { vercelBlobBackend } from './vercel-blob';
import type { BlobBackend } from './backend';

/**
 * P1 D7: Vercel Blob when a token is set, otherwise local disk under
 * STORAGE_DIR (default ./data/blobs). A self-hoster sets nothing.
 *
 * Except on Vercel itself (VERCEL is set there): a function's disk is
 * ephemeral, so falling back to it would make every read miss and every write
 * vanish while the database kept pointing at objects that are not there. The
 * SDK can also authenticate by OIDC + BLOB_STORE_ID, so a missing token there
 * is a real misconfiguration, and it must fail loudly instead.
 */
export function selectBackend(env: Record<string, string | undefined> = process.env): BlobBackend {
  if (env.BLOB_READ_WRITE_TOKEN?.trim()) return vercelBlobBackend();
  if (env.VERCEL?.trim()) {
    throw new Error('storage: running on Vercel without BLOB_READ_WRITE_TOKEN -- refusing to fall back to local disk');
  }
  return localBackend(env.STORAGE_DIR?.trim() || './data/blobs');
}

let cached: BlobBackend | null = null;

/**
 * The process's backend, chosen on first use rather than at import, so a
 * script that loads its env file after importing the stores still selects
 * from the loaded environment.
 */
export function backend(): BlobBackend {
  return (cached ??= selectBackend());
}

/** What the About page names as file storage (spec D5: the kind, never the store's URL or token). */
export function storageLabel(): string {
  return backend().label;
}
