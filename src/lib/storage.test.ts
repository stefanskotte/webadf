import { describe, it, expect, vi, beforeEach } from 'vitest';

const issueSignedToken = vi.fn();
const presignUrl = vi.fn();
const head = vi.fn();
const get = vi.fn();
const del = vi.fn();

class BlobNotFoundError extends Error {
  constructor() { super('The requested blob does not exist'); this.name = 'BlobNotFoundError'; }
}

vi.mock('@vercel/blob', () => ({ issueSignedToken, presignUrl, head, get, del, BlobNotFoundError }));

const SHA = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  issueSignedToken.mockResolvedValue({
    delegationToken: 'del', clientSigningToken: 'sign', validUntil: Date.now() + 3_600_000,
  });
  presignUrl.mockResolvedValue({ presignedUrl: 'https://store.private.blob.vercel-storage.com/x' });
});

describe('diskStore', () => {
  it('derives a deterministic storage key from the hash', async () => {
    const { diskStore } = await import('./storage');
    expect(diskStore.storageKey(SHA)).toBe(`adf/${SHA}`);
  });

  it('rejects anything that is not a 64-char hex digest', async () => {
    const { diskStore } = await import('./storage');
    await expect(diskStore.uploadUrl('nope', 100)).rejects.toThrow(/sha-?256/i);
  });

  it('scopes the upload token to the exact path and size, and forbids overwrite', async () => {
    const { diskStore } = await import('./storage');
    await diskStore.uploadUrl(SHA, 901_120);

    expect(issueSignedToken).toHaveBeenCalledWith(expect.objectContaining({
      pathname: `adf/${SHA}`, operations: ['put'], maximumSizeInBytes: 901_120,
    }));
    expect(presignUrl).toHaveBeenCalledWith(
      expect.objectContaining({ delegationToken: 'del', clientSigningToken: 'sign' }),
      expect.objectContaining({
        operation: 'put', access: 'private',
        addRandomSuffix: false, allowOverwrite: false,
      }),
    );
  });

  it('returns the presigned url string, not the wrapper object', async () => {
    const { diskStore } = await import('./storage');
    const out = await diskStore.uploadUrl(SHA, 100);
    expect(out.url).toBe('https://store.private.blob.vercel-storage.com/x');
  });

  it('issues a private GET with the requested ttl', async () => {
    const { diskStore } = await import('./storage');
    await diskStore.downloadUrl(SHA, 900);
    expect(presignUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'get', access: 'private' }),
    );
  });

  it('reports a missing blob as null rather than throwing', async () => {
    head.mockRejectedValue(new BlobNotFoundError());
    const { diskStore } = await import('./storage');
    await expect(diskStore.stat(SHA)).resolves.toBeNull();
  });

  // The size head() already knows is what /api/ingest/complete compares the
  // client's claim against, so stat() must surface it rather than collapsing
  // the whole response to a boolean the way exists() used to.
  it('surfaces the stored size, not just presence', async () => {
    head.mockResolvedValue({ size: 901_120 });
    const { diskStore } = await import('./storage');
    await expect(diskStore.stat(SHA)).resolves.toEqual({ sizeBytes: 901_120 });
  });

  it('propagates unexpected head errors instead of reporting absence', async () => {
    head.mockRejectedValue(new Error('network is on fire'));
    const { diskStore } = await import('./storage');
    await expect(diskStore.stat(SHA)).rejects.toThrow('network is on fire');
  });

  // A CDN-cached copy could answer with something other than what origin
  // storage now holds -- which is exactly the thing the digest check exists
  // to detect. Reading through the cache would make the verification a lie.
  it('reads bytes back with the CDN cache bypassed', async () => {
    get.mockResolvedValue({
      statusCode: 200,
      stream: new Response(new Uint8Array([1, 2, 3])).body,
    });
    const { diskStore } = await import('./storage');
    await expect(diskStore.read(SHA)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(get).toHaveBeenCalledWith(`adf/${SHA}`, { access: 'private', useCache: false });
  });

  it('throws rather than returning empty bytes when the read-back fails', async () => {
    get.mockResolvedValue(null);
    const { diskStore } = await import('./storage');
    await expect(diskStore.read(SHA)).rejects.toThrow(/verification/);
  });

  it('removes by content-addressed key', async () => {
    del.mockResolvedValue(undefined);
    const { diskStore } = await import('./storage');
    await diskStore.remove(SHA);
    expect(del).toHaveBeenCalledWith(`adf/${SHA}`);
  });

  it('refuses to remove anything that is not a digest', async () => {
    const { diskStore } = await import('./storage');
    await expect(diskStore.remove('../../secrets')).rejects.toThrow(/sha-?256/i);
    expect(del).not.toHaveBeenCalled();
  });
});
