import { describe, it, expect } from 'vitest';
import { selectUnreferencedBlobs, selectReleasableUploads } from './blob-gc';

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

  it('keeps a blob that only a disk history still names', () => {
    // Disks D and E share S0; D is edited, so its history starts at S0; E is
    // deleted, which drops the org's entitlement to S0. No disk and no
    // entitlement names S0 any more, but D's history cannot be rebuilt
    // without it.
    expect(selectUnreferencedBlobs(['s0', 'x'], [], [], ['s0'])).toEqual(['x']);
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

describe('selectReleasableUploads', () => {
  // A refused upload's bytes sit in the store with no row of their own. They
  // may go only when NOTHING claims them: the same rule as the teardown's GC,
  // plus the one fact that rule gets for free from walking `blobs` -- that no
  // blobs row names the sha at all.

  it('releases bytes no blobs row and no reference names', () => {
    expect(selectReleasableUploads(['r'], [], [], [], [])).toEqual(['r']);
  });

  it('keeps bytes a blobs row names, even with nothing else pointing at them', () => {
    // Another org registered these exact bytes (as an ADF, say): the row is
    // the proof they are somebody's content, and deleting would break it.
    expect(selectReleasableUploads(['r'], ['r'], [], [], [])).toEqual([]);
  });

  it('keeps bytes a disk, an entitlement or a history names', () => {
    expect(selectReleasableUploads(['d', 'e', 'h', 'x'], [], ['d'], ['e'], ['h'])).toEqual(['x']);
  });

  it('handles no candidates', () => {
    expect(selectReleasableUploads([], ['a'], [], [], [])).toEqual([]);
  });
});
