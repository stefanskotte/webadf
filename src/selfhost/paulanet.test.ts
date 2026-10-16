import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensurePaulanetDisk } from './paulanet';

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
