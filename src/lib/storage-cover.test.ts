import { describe, it, expect, vi, beforeEach } from 'vitest';

// The cover/ namespace, against a mocked SDK: the keys it writes and lists,
// and that the adf/ listing the GC deletes from can never include a cover.
const put = vi.fn();
const get = vi.fn();
const del = vi.fn();
const list = vi.fn();
vi.mock('@vercel/blob', () => ({
  put, get, del, list, head: vi.fn(), issueSignedToken: vi.fn(), presignUrl: vi.fn(),
  BlobNotFoundError: class extends Error {},
}));

const SHA = 'c'.repeat(64);
const { coverStore, diskStore } = await import('./storage');

beforeEach(() => { vi.clearAllMocks(); });

describe('coverStore', () => {
  it('writes cover/<sha256>, private, with the sniffed type, refreshing the upload time', async () => {
    put.mockResolvedValue({});
    expect(await coverStore.put(SHA, new Uint8Array([1]), 'image/png')).toEqual({ key: `cover/${SHA}` });
    expect(put).toHaveBeenCalledWith(`cover/${SHA}`, expect.anything(), expect.objectContaining({
      access: 'private', contentType: 'image/png', addRandomSuffix: false, allowOverwrite: true,
    }));
  });

  it('refuses a key that is not a sha-256 (no path walking into adf/ or oagd/)', async () => {
    await expect(coverStore.put('../adf/x', new Uint8Array([1]), 'image/png')).rejects.toThrow(/sha-256/);
    expect(await coverStore.read('../adf/' + 'a'.repeat(57))).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('lists only cover/ and only digest-named objects', async () => {
    list.mockResolvedValue({
      blobs: [
        { pathname: `cover/${SHA}`, uploadedAt: '2026-10-01T00:00:00Z' },
        { pathname: 'cover/notes.txt', uploadedAt: '2026-10-01T00:00:00Z' },
      ],
      hasMore: false,
    });
    expect(await coverStore.listAll()).toEqual([{ sha256: SHA, uploadedAt: new Date('2026-10-01T00:00:00Z') }]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'cover/' }));
  });

  it('the adf/ pass lists adf/ only, so the disk GC can never see (or delete) a cover', async () => {
    list.mockResolvedValue({ blobs: [], hasMore: false });
    await diskStore.listAll();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'adf/' }));
  });

  it('removes cover/<sha256>', async () => {
    await coverStore.remove(SHA);
    expect(del).toHaveBeenCalledWith(`cover/${SHA}`);
  });
});
