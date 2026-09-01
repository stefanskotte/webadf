import { describe, it, expect } from 'vitest';
import { selectUnreferencedBlobs } from './blob-gc';

describe('selectUnreferencedBlobs', () => {
  it('keeps a blob that a disk still points at', () => {
    expect(selectUnreferencedBlobs(['a'], ['a'], [])).toEqual([]);
  });

  it('keeps a blob that an entitlement still points at', () => {
    // The entitlement is the tenant's PROOF they uploaded these bytes. A blob
    // can outlive every disk row and still be entitled -- deleting it would
    // silently revoke that proof.
    expect(selectUnreferencedBlobs(['a'], [], ['a'])).toEqual([]);
  });

  it('keeps a blob referenced by ANOTHER tenant, not just the caller', () => {
    // The rule this whole function exists to protect. 26 blobs in this system
    // are already shared across organizations; deleting one because the org
    // being torn down stopped referencing it would destroy a stranger's disk.
    expect(selectUnreferencedBlobs(['shared'], ['shared'], [])).toEqual([]);
  });

  it('returns a blob nothing references at all', () => {
    expect(selectUnreferencedBlobs(['orphan'], [], [])).toEqual(['orphan']);
  });

  it('separates the referenced from the unreferenced in one pass', () => {
    expect(selectUnreferencedBlobs(['a', 'b', 'c', 'd'], ['a'], ['c']).sort())
      .toEqual(['b', 'd']);
  });

  it('is not confused by a reference to a blob that no longer exists', () => {
    // disks.sha256 has a foreign key, but entitlements can be deleted in a
    // different statement of the same batch -- a dangling reference must not
    // make a real orphan look referenced.
    expect(selectUnreferencedBlobs(['a'], ['ghost'], ['also-ghost'])).toEqual(['a']);
  });

  it('handles an empty store without returning undefined', () => {
    expect(selectUnreferencedBlobs([], [], [])).toEqual([]);
  });

  it('deduplicates, so a blob with two disks is reported once if freed', () => {
    expect(selectUnreferencedBlobs(['a', 'a'], [], [])).toEqual(['a']);
  });
});
