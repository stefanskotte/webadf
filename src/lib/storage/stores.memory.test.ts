import { describe, it, expect, vi } from 'vitest';

// The stores on a backend that is not Vercel Blob (the in-memory fake stands
// in for local disk): same reconciliation, same round trips.
vi.mock('@/lib/storage/select', async () => {
  const { memoryBackend } = await import('@/lib/storage/memory');
  const b = memoryBackend();
  return { backend: () => b, storageLabel: () => b.label };
});

const { diskStore, coverStore, firmwareStore } = await import('@/lib/storage');
const SHA = 'c'.repeat(64);

describe('stores on another backend', () => {
  it('diskStore: put twice reconciles, then stat/read/listAll/remove', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await diskStore.put(SHA, bytes)).toEqual({ key: `adf/${SHA}` });
    expect(await diskStore.put(SHA, bytes)).toEqual({ key: `adf/${SHA}` });
    expect(await diskStore.stat(SHA)).toEqual({ sizeBytes: 3 });
    expect(await diskStore.read(SHA)).toEqual(bytes);
    expect((await diskStore.listAll()).map((o) => o.sha256)).toEqual([SHA]);
    await diskStore.remove(SHA);
    expect(await diskStore.stat(SHA)).toBeNull();
    await expect(diskStore.read(SHA)).rejects.toThrow(/verification/);
  });

  it('coverStore overwrites and keeps the content type', async () => {
    await coverStore.put(SHA, new Uint8Array([1]), 'image/png');
    await coverStore.put(SHA, new Uint8Array([2]), 'image/jpeg');
    expect(await coverStore.read(SHA)).toEqual({ bytes: new Uint8Array([2]), contentType: 'image/jpeg' });
  });

  it('firmwareStore: put, readStream with size, refuse a second put without overwrite, remove', async () => {
    const path = 'firmware/1.13.0+g290990b.bin';
    await firmwareStore.put(path, new Uint8Array([9, 9]), { overwrite: false });
    await expect(firmwareStore.put(path, new Uint8Array([8]), { overwrite: false })).rejects.toThrow(/already exists/);
    const r = await firmwareStore.readStream(path);
    expect(r?.sizeBytes).toBe(2);
    expect(new Uint8Array(await new Response(r!.stream).arrayBuffer())).toEqual(new Uint8Array([9, 9]));
    await firmwareStore.remove(path);
    expect(await firmwareStore.read(path)).toBeNull();
  });
});
