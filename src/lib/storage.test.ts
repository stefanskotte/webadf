import { describe, it, expect, vi, beforeEach } from 'vitest';

const issueSignedToken = vi.fn();
const presignUrl = vi.fn();
const head = vi.fn();

class BlobNotFoundError extends Error {
  constructor() { super('The requested blob does not exist'); this.name = 'BlobNotFoundError'; }
}

vi.mock('@vercel/blob', () => ({ issueSignedToken, presignUrl, head, BlobNotFoundError }));

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

  it('reports a missing blob as false rather than throwing', async () => {
    head.mockRejectedValue(new BlobNotFoundError());
    const { diskStore } = await import('./storage');
    await expect(diskStore.exists(SHA)).resolves.toBe(false);
  });

  it('reports an existing blob as true', async () => {
    head.mockResolvedValue({ size: 901_120 });
    const { diskStore } = await import('./storage');
    await expect(diskStore.exists(SHA)).resolves.toBe(true);
  });

  it('propagates unexpected head errors instead of reporting absence', async () => {
    head.mockRejectedValue(new Error('network is on fire'));
    const { diskStore } = await import('./storage');
    await expect(diskStore.exists(SHA)).rejects.toThrow('network is on fire');
  });
});
