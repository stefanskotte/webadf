import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensurePaulanetDisk, storeBundledPaulanetDisk } from './paulanet';

const adf = Buffer.from('an adf');
const sha = createHash('sha256').update(adf).digest('hex');
const file = () => { const p = join(mkdtempSync(join(tmpdir(), 'p-')), 'paulanet.adf'); writeFileSync(p, adf); return p; };

describe('ensurePaulanetDisk', () => {
  it('stores the bundled disk under its sha when missing', async () => {
    const put: string[] = [];
    expect(await ensurePaulanetDisk({ adfPath: file(), expectedSha256: sha, has: async () => false, put: async (s) => { put.push(s); } })).toBe('stored');
    expect(put).toEqual([sha]);
  });
  it('does nothing when present', async () => {
    expect(await ensurePaulanetDisk({ adfPath: file(), expectedSha256: sha, has: async () => true, put: async () => { throw new Error('no'); } })).toBe('present');
  });
  it('refuses a bundled disk that is not the pinned one', async () => {
    await expect(ensurePaulanetDisk({ adfPath: file(), expectedSha256: 'f'.repeat(64), has: async () => false, put: async () => {} }))
      .rejects.toThrow(/not the pinned PaulaNET disk/);
  });
});

describe('storeBundledPaulanetDisk', () => {
  it('never throws: a failing store is logged loudly', async () => {
    const lines: string[] = [];
    await expect(storeBundledPaulanetDisk({ adfPath: file(), expectedSha256: sha, has: async () => { throw new Error('disk full'); }, put: async () => {} }, (l) => lines.push(l))).resolves.toBeUndefined();
    await storeBundledPaulanetDisk({ adfPath: file(), expectedSha256: sha, has: async () => false, put: async () => { throw new Error('boom'); } }, (l) => lines.push(l));
    expect(lines).toEqual([
      'PaulaNET driver disk NOT stored: disk full -- /api/paulanet-disk answers 503 until it is',
      'PaulaNET driver disk NOT stored: boom -- /api/paulanet-disk answers 503 until it is',
    ]);
  });
});
