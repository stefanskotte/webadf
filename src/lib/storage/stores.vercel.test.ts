import { describe, it, expect, vi, beforeEach } from 'vitest';

// The stores on the Vercel Blob backend, against a mocked SDK: the exact calls
// production made before the backend seam existed. No network.
const put = vi.fn();
const get = vi.fn();
const head = vi.fn();
const del = vi.fn();
class BlobNotFoundError extends Error {}
vi.mock('@vercel/blob', () => ({
  put, get, head, del, list: vi.fn(), issueSignedToken: vi.fn(), presignUrl: vi.fn(), BlobNotFoundError,
}));
vi.mock('@/lib/storage/select', async () => {
  const { vercelBlobBackend } = await import('@/lib/storage/vercel-blob');
  const b = vercelBlobBackend();
  return { backend: () => b, storageLabel: () => b.label };
});

const { diskStore, imageStore, coverStore, demozooExportStore, firmwareStore, storageLabel } = await import('@/lib/storage');

const SHA256 = 'a'.repeat(64);
const SHA1 = 'b'.repeat(40);
// The real body Vercel Blob answers a second put of a no-overwrite key with (blob-upload.test.ts).
const EXISTS = new Error('Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.');

beforeEach(() => { vi.clearAllMocks(); });

const okGet = (body: string, headers: Record<string, string> = {}) => ({
  statusCode: 200, stream: new Response(body).body, headers: new Headers(headers),
});

describe('stores on Vercel Blob', () => {
  // Review finding (Critical): the SDK reports statusCode 200 for EVERY successful answer, a 206 included, so the
  // ranged read must judge by the body, never by the status code.
  it('diskStore.readRange: a ranged answer (statusCode 200 from the SDK) is returned as it is', async () => {
    get.mockResolvedValueOnce(okGet('MNOP', { 'content-range': 'bytes 16384-16387/20000' }));
    const b = await diskStore.readRange(SHA256, 16384, 4);
    expect(new TextDecoder().decode(b)).toBe('MNOP');
    expect(get).toHaveBeenCalledWith(`adf/${SHA256}`, expect.objectContaining({ headers: { range: 'bytes=16384-16387' } }));
  });
  it('diskStore.readRange: a store that ignored Range sent the whole object -- sliced here', async () => {
    get.mockResolvedValueOnce(okGet('ABCDEFGHIJ'));
    expect(new TextDecoder().decode(await diskStore.readRange(SHA256, 3, 4))).toBe('DEFG');
  });

  it('names itself for the About page', () => {
    expect(storageLabel()).toBe('Vercel Blob');
  });

  it('diskStore.put: private, no overwrite, and an existing object is reconciled as success', async () => {
    put.mockRejectedValueOnce(EXISTS);
    await expect(diskStore.put(SHA256, new Uint8Array([1]))).resolves.toEqual({ key: `adf/${SHA256}` });
    expect(put).toHaveBeenCalledWith(`adf/${SHA256}`, expect.any(Buffer), {
      access: 'private', contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: false,
    });
  });

  it('diskStore.put: any other failure still throws', async () => {
    put.mockRejectedValueOnce(new Error('network is on fire'));
    await expect(diskStore.put(SHA256, new Uint8Array([1]))).rejects.toThrow('network is on fire');
  });

  it('imageStore.put: no overwrite, reconciles an existing object', async () => {
    put.mockRejectedValueOnce(EXISTS);
    await expect(imageStore.put(SHA1, new Uint8Array([1]), 'image/jpeg')).resolves.toEqual({ key: `oagd/${SHA1}` });
    expect(put).toHaveBeenCalledWith(`oagd/${SHA1}`, expect.any(Buffer), {
      access: 'private', contentType: 'image/jpeg', addRandomSuffix: false, allowOverwrite: false,
    });
  });

  it('imageStore.read and coverStore.read go through the cache, exactly as before', async () => {
    get.mockResolvedValueOnce(okGet('img', { 'content-type': 'image/gif' }));
    expect(await imageStore.read(SHA1)).toEqual({ bytes: new TextEncoder().encode('img'), contentType: 'image/gif' });
    expect(get).toHaveBeenLastCalledWith(`oagd/${SHA1}`, { access: 'private' });

    get.mockResolvedValueOnce(okGet('cov'));
    expect((await coverStore.read(SHA256))?.contentType).toBe('application/octet-stream');
    expect(get).toHaveBeenLastCalledWith(`cover/${SHA256}`, { access: 'private' });
  });

  it("imageStore.read keeps its own 'image/png' default when the type is unknown", async () => {
    get.mockResolvedValueOnce(okGet('img'));
    expect((await imageStore.read(SHA1))?.contentType).toBe('image/png');
  });

  it('demozooExportStore.putBytes: overwrite, multipart, as before', async () => {
    await demozooExportStore.putBytes('amiga.json', new Uint8Array([1]));
    expect(put).toHaveBeenCalledWith('demozoo/amiga.json', expect.any(Buffer), {
      access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true, multipart: true,
    });
  });

  it('firmwareStore.readStream: uncached, with the size from the response', async () => {
    get.mockResolvedValueOnce(okGet('fw!', { 'content-length': '3' }));
    const r = await firmwareStore.readStream('firmware/1.13.0+g290990b.bin');
    expect(r?.sizeBytes).toBe(3);
    expect(get).toHaveBeenCalledWith('firmware/1.13.0+g290990b.bin', { access: 'private', useCache: false });
    get.mockResolvedValueOnce(null);
    expect(await firmwareStore.readStream('firmware/x.bin')).toBeNull();
  });

  it('firmwareStore.put overwrites by default (e2e), and not when the publish script says so', async () => {
    await firmwareStore.put('firmware/0.0.0+e2e71.bin', new Uint8Array([1]));
    expect(put).toHaveBeenLastCalledWith('firmware/0.0.0+e2e71.bin', expect.any(Buffer), {
      access: 'private', contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: true,
    });
    await firmwareStore.put('firmware/1.13.0+g290990b.bin', new Uint8Array([1]), { overwrite: false });
    expect(put).toHaveBeenLastCalledWith('firmware/1.13.0+g290990b.bin', expect.any(Buffer), {
      access: 'private', contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: false,
    });
  });

  it('firmwareStore.stat and remove', async () => {
    head.mockResolvedValueOnce({ size: 42, uploadedAt: '2026-10-01T00:00:00Z' });
    expect(await firmwareStore.stat('firmware/a.bin')).toEqual({ sizeBytes: 42 });
    head.mockRejectedValueOnce(new BlobNotFoundError());
    expect(await firmwareStore.stat('firmware/a.bin')).toBeNull();
    await firmwareStore.remove('firmware/a.bin');
    expect(del).toHaveBeenCalledWith('firmware/a.bin');
  });
});
