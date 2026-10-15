import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryBackend } from '@/lib/storage/memory';
import { signUpload } from '@/lib/storage/upload-sig';
import { classifyUpload, isExpiredPresign } from '@/lib/blob-upload';
import type { BlobBackend } from '@/lib/storage/backend';

let mem: BlobBackend & { label: string };
vi.mock('@/lib/storage/select', () => ({ backend: () => mem, storageLabel: () => mem.label }));

import { PUT } from './[...key]/route';

const SHA = 'c'.repeat(64);
const KEY = `adf/${SHA}`;
const ctx = { params: Promise.resolve({ key: ['adf', SHA] }) };

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789';
  process.env.BETTER_AUTH_URL = 'https://example.test';
  mem = { ...memoryBackend(), label: 'Local disk' } as typeof mem;
  // keep methods bound to the same store
});

const put = (url: string, body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'PUT', body, headers, ...(typeof body === 'object' && !(body instanceof Uint8Array) ? { duplex: 'half' } : {}) } as RequestInit);

describe('PUT /api/blob-upload', () => {
  it('stores a good upload, then answers 400 already-exists', async () => {
    const { url } = await signUpload(KEY, 10, 60_000);
    const r = await PUT(put(url, new Uint8Array([1, 2, 3])), ctx);
    expect(r.status).toBe(200);
    expect((await mem.head(KEY))?.sizeBytes).toBe(3);
    const again = await PUT(put(url, new Uint8Array([1, 2, 3])), ctx);
    expect(again.status).toBe(400);
    const body = await again.text();
    expect(body).toMatch(/This blob already exists/);
    expect(classifyUpload(400, false, body)).toBe('already-stored');
  });

  it('answers 403 for an expired URL', async () => {
    const { url } = await signUpload(KEY, 10, 60_000, Date.now() - 120_000);
    const r = await PUT(put(url, new Uint8Array([1])), ctx);
    expect(r.status).toBe(403);
    expect(isExpiredPresign(r.status)).toBe(true);
    expect(await mem.head(KEY)).toBeNull();
  });

  it('answers 403 for a URL signed for another key', async () => {
    const { url } = await signUpload(`adf/${'d'.repeat(64)}`, 10, 60_000);
    expect((await PUT(put(url, new Uint8Array([1])), ctx)).status).toBe(403);
  });

  it('answers 413 one byte over max with an honest content-length', async () => {
    const { url } = await signUpload(KEY, 4, 60_000);
    const r = await PUT(put(url, new Uint8Array(5)), ctx);
    expect(r.status).toBe(413);
    expect(await mem.head(KEY)).toBeNull();
  });

  it('answers 413 over max with no content-length (a stream)', async () => {
    const { url } = await signUpload(KEY, 4, 60_000);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); c.close(); },
    });
    const req = new Request(url, { method: 'PUT', body: stream, duplex: 'half' } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    const r = await PUT(req, ctx);
    expect(r.status).toBe(413);
    expect(await mem.head(KEY)).toBeNull();
  });

  it('answers 404 when the backend is Vercel Blob', async () => {
    const { url } = await signUpload(KEY, 10, 60_000);
    mem.label = 'Vercel Blob';
    expect((await PUT(put(url, new Uint8Array([1])), ctx)).status).toBe(404);
  });
});
