import { describe, it, expect, vi, beforeEach } from 'vitest';

const put = vi.fn(async () => ({}));
const get = vi.fn();
vi.mock('@vercel/blob', () => ({
  put, get, head: vi.fn(), del: vi.fn(), issueSignedToken: vi.fn(), presignUrl: vi.fn(),
  BlobNotFoundError: class extends Error {},
}));

beforeEach(() => { put.mockClear(); get.mockReset(); });

describe('demozooExportStore', () => {
  it('streams the export under a fixed private key, multipart, overwriting', async () => {
    const { demozooExportStore } = await import('./storage');
    const body = new Blob(['x']).stream();
    await demozooExportStore.putStream('export.sql.gz', body);
    expect(put).toHaveBeenCalledWith('demozoo/export.sql.gz', body, expect.objectContaining({
      access: 'private', multipart: true, allowOverwrite: true, addRandomSuffix: false,
    }));
  });

  it('returns the stream unbuffered, or null when absent', async () => {
    const { demozooExportStore } = await import('./storage');
    const stream = new Blob(['y']).stream();
    get.mockResolvedValueOnce({ statusCode: 200, stream });
    expect(await demozooExportStore.readStream('amiga.json')).toBe(stream);
    get.mockResolvedValueOnce(null);
    expect(await demozooExportStore.readStream('amiga.json')).toBeNull();
    expect(get).toHaveBeenCalledWith('demozoo/amiga.json', { access: 'private', useCache: false });
  });
});
