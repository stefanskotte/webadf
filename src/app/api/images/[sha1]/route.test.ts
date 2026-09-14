import { describe, it, expect, vi } from 'vitest';

const read = vi.fn();
vi.mock('@/lib/storage', () => ({ imageStore: { read } }));

const { GET } = await import('./route');

describe('GET /api/images/[sha1]', () => {
  it('serves a stored image with nosniff, so a stored content type is never second-guessed', async () => {
    read.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });

    const res = await GET(new Request('http://localhost/api/images/x'), { params: Promise.resolve({ sha1: 'a'.repeat(40) }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
