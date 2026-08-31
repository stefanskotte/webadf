import { describe, it, expect } from 'vitest';
import { contentHashes } from './content-hashes';

describe('contentHashes', () => {
  it('computes all four digests of the empty input', () => {
    const h = contentHashes(new Uint8Array(0));
    expect(h.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(h.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(h.md5).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(h.crc32).toBe('00000000');
  });

  it('returns lowercase hex for every digest', () => {
    const h = contentHashes(new TextEncoder().encode('abc'));
    for (const v of [h.sha256, h.sha1, h.md5, h.crc32]) expect(v).toMatch(/^[0-9a-f]+$/);
  });

  it('agrees with the known sha256 the ingest path already enforces', () => {
    // Same value ingest/complete's verify() computes, so a mismatch here
    // would mean this helper cannot be trusted to replace that call.
    expect(contentHashes(new TextEncoder().encode('abc')).sha256)
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
