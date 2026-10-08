import { describe, it, expect } from 'vitest';
import { selectUnreferencedBlobs, selectReleasableUploads, planBlobGc } from './blob-gc';

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

describe('planBlobGc', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const old = new Date('2026-09-01T00:00:00Z');
  const young = new Date('2026-10-08T11:00:00Z');
  const grace = 7 * 24 * 3600 * 1000;
  const base = { now, graceMs: grace };

  it('deletes an old unreferenced row, and keeps referenced and young ones', () => {
    const plan = planBlobGc({
      ...base,
      rows: [{ sha256: 'gone', createdAt: old }, { sha256: 'used', createdAt: old }, { sha256: 'new', createdAt: young }],
      objects: [{ sha256: 'gone', uploadedAt: old }, { sha256: 'used', uploadedAt: old }, { sha256: 'new', uploadedAt: young }],
      referenced: ['used'],
    });
    expect(plan).toEqual({ rows: ['gone'], objects: [], refused: null });
  });

  it('removes an old object with no row and no reference (an orphaned delta), never a referenced one', () => {
    const plan = planBlobGc({
      ...base, rows: [],
      objects: [{ sha256: 'orphan', uploadedAt: old }, { sha256: 'delta', uploadedAt: old }],
      referenced: ['delta'],
    });
    expect(plan).toEqual({ rows: [], objects: ['orphan'], refused: null });
  });

  it('keeps a young object with no row: an upload whose complete has not run yet', () => {
    const plan = planBlobGc({ ...base, rows: [], objects: [{ sha256: 'inflight', uploadedAt: young }], referenced: [] });
    expect(plan.objects).toEqual([]);
  });

  it('never removes the object of a row it keeps, even an unreferenced young row', () => {
    const plan = planBlobGc({
      ...base, rows: [{ sha256: 'r', createdAt: young }], objects: [{ sha256: 'r', uploadedAt: old }], referenced: [],
    });
    expect(plan).toEqual({ rows: [], objects: [], refused: null });
  });

  it('refuses when the listing does not line up with the rows (live bytes would look orphaned)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ sha256: `r${i}`, createdAt: old }));
    // A listing whose keys parse differently: none of the rows' objects is "there".
    const objects = rows.map((r) => ({ sha256: `x-${r.sha256}`, uploadedAt: old }));
    const plan = planBlobGc({ ...base, rows, objects, referenced: rows.map((r) => r.sha256) });
    expect(plan.objects).toEqual([]);
    expect(plan.refused).toMatch(/only 0 of 10 rows/);
  });

  it('refuses when an implausible share of the ROWS would go (a reference list came back short)', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ sha256: `s${i}`, createdAt: old }));
    const objects = rows.map((r) => ({ sha256: r.sha256, uploadedAt: old }));
    const plan = planBlobGc({ ...base, rows, objects, referenced: [] });
    expect(plan.rows).toEqual([]);
    expect(plan.refused).toMatch(/would delete 400 of 400 blob rows/);
  });

  it('does clear a large backlog of row-less, unreferenced objects when the rows line up', () => {
    const rows = [{ sha256: 'live', createdAt: old }];
    const objects = [{ sha256: 'live', uploadedAt: old },
      ...Array.from({ length: 1000 }, (_, i) => ({ sha256: `leak${i}`, uploadedAt: old }))];
    const plan = planBlobGc({ ...base, rows, objects, referenced: ['live'] });
    expect(plan.refused).toBeNull();
    expect(plan.objects).toHaveLength(1000);
    expect(plan.objects).not.toContain('live');
  });

  it('allows a small plan on a small store (the floor)', () => {
    const plan = planBlobGc({
      ...base, rows: [], objects: [{ sha256: 'a', uploadedAt: old }, { sha256: 'b', uploadedAt: old }], referenced: [],
    });
    expect(plan.objects).toEqual(['a', 'b']);
    expect(plan.refused).toBeNull();
  });
});
