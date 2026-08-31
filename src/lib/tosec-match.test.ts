import { describe, it, expect } from 'vitest';
import { matchBlob, type Candidate } from './tosec-match';

const SIZE = 901120;
const A: Candidate = { id: 'a', crc32: 'aaaaaaaa', md5: 'a'.repeat(32), sha1: 'a'.repeat(40), sizeBytes: SIZE };
const B: Candidate = { id: 'b', crc32: 'aaaaaaaa', md5: 'b'.repeat(32), sha1: 'b'.repeat(40), sizeBytes: SIZE };

describe('matchBlob', () => {
  it('matches on sha1 when present', () => {
    const v = matchBlob({ crc32: null, md5: null, sha1: 'a'.repeat(40), sizeBytes: SIZE }, [A, B]);
    expect(v).toEqual({ state: 'matched', entryId: 'a' });
  });

  it('prefers sha1 over a crc32 that points elsewhere', () => {
    // Both candidates share a crc32; only sha1 disambiguates. A cascade that
    // checked crc32 first would call this ambiguous and give up.
    const v = matchBlob({ crc32: 'aaaaaaaa', md5: null, sha1: 'b'.repeat(40), sizeBytes: SIZE }, [A, B]);
    expect(v).toEqual({ state: 'matched', entryId: 'b' });
  });

  it('falls back to md5 when sha1 is absent on both sides', () => {
    const noSha: Candidate[] = [{ ...A, sha1: null }, { ...B, sha1: null }];
    const v = matchBlob({ crc32: null, md5: 'b'.repeat(32), sha1: null, sizeBytes: SIZE }, noSha);
    expect(v).toEqual({ state: 'matched', entryId: 'b' });
  });

  it('uses crc32 ONLY together with size', () => {
    const only: Candidate[] = [{ id: 'c', crc32: 'deadbeef', md5: null, sha1: null, sizeBytes: SIZE }];
    expect(matchBlob({ crc32: 'deadbeef', md5: null, sha1: null, sizeBytes: SIZE }, only))
      .toEqual({ state: 'matched', entryId: 'c' });
    // Same crc32, different size -- a 32-bit checksum collides, so this must NOT match.
    expect(matchBlob({ crc32: 'deadbeef', md5: null, sha1: null, sizeBytes: 12345 }, only))
      .toEqual({ state: 'none' });
  });

  it('reports ambiguity instead of picking one', () => {
    const twins: Candidate[] = [A, { ...B, sha1: 'a'.repeat(40) }];
    const v = matchBlob({ crc32: null, md5: null, sha1: 'a'.repeat(40), sizeBytes: SIZE }, twins);
    expect(v.state).toBe('ambiguous');
    expect((v as { entryIds: string[] }).entryIds.sort()).toEqual(['a', 'b']);
  });

  it('is none when nothing matches', () => {
    expect(matchBlob({ crc32: null, md5: null, sha1: 'f'.repeat(40), sizeBytes: SIZE }, [A, B]))
      .toEqual({ state: 'none' });
  });

  it('is none when the blob has no hashes at all', () => {
    expect(matchBlob({ crc32: null, md5: null, sha1: null, sizeBytes: SIZE }, [A, B]))
      .toEqual({ state: 'none' });
  });

  it('is none with no candidates', () => {
    expect(matchBlob({ crc32: null, md5: null, sha1: 'a'.repeat(40), sizeBytes: SIZE }, []))
      .toEqual({ state: 'none' });
  });

  it('never matches a null against a null', () => {
    // Two entries with no sha1 must not "both match" a blob with no sha1.
    const nulls: Candidate[] = [{ id: 'x', crc32: null, md5: null, sha1: null, sizeBytes: SIZE }];
    expect(matchBlob({ crc32: null, md5: null, sha1: null, sizeBytes: SIZE }, nulls))
      .toEqual({ state: 'none' });
  });
});
