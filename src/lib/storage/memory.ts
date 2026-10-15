import { assertKey, BlobExistsError, type BlobBackend } from './backend';

/**
 * In-memory BlobBackend for unit tests: the same contract as the real ones
 * (backend.contract.ts), no I/O. Each call returns an empty, independent store.
 */
export function memoryBackend(): BlobBackend {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; uploadedAt: Date }>();

  return {
    label: 'Memory',

    async put(key, body, { contentType, overwrite }) {
      assertKey(key);
      // Check BEFORE the first await so a refused put never consumes the body
      // pointlessly; check again after, synchronously with the set, so two
      // concurrent puts cannot both win.
      if (!overwrite && objects.has(key)) throw new BlobExistsError(key);
      const bytes = body instanceof Uint8Array
        ? new Uint8Array(body)
        : new Uint8Array(await new Response(body).arrayBuffer());
      if (!overwrite && objects.has(key)) throw new BlobExistsError(key);
      objects.set(key, { bytes, contentType, uploadedAt: new Date() });
    },

    async get(key) {
      assertKey(key);
      const o = objects.get(key);
      if (!o) return null;
      return { stream: new Response(o.bytes.slice()).body!, contentType: o.contentType, sizeBytes: o.bytes.byteLength };
    },

    async head(key) {
      assertKey(key);
      const o = objects.get(key);
      return o ? { sizeBytes: o.bytes.byteLength, uploadedAt: o.uploadedAt } : null;
    },

    async del(key) {
      assertKey(key);
      objects.delete(key);
    },

    async *list(prefix) {
      for (const [key, o] of [...objects]) {
        if (key.startsWith(prefix)) yield { key, uploadedAt: o.uploadedAt };
      }
    },

    async uploadUrl(key, { ttlMs }) {
      assertKey(key);
      return { url: `memory://${key}`, expiresAt: new Date(Date.now() + ttlMs) };
    },
  };
}
