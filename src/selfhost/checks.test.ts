import { describe, it, expect } from 'vitest';
import { mkdtempSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFreeSpace, checkWritable, checkPgData, GB } from './checks';

describe('checkFreeSpace', () => {
  it('fails under 1 GB with the amount and the reason', () => {
    const r = checkFreeSpace(0.4 * GB, 'the data folder');
    expect(r.level).toBe('fail');
    expect(r.message).toMatch(/only 0\.4 GB free on the data folder: webadf needs at least 1 GB/);
  });
  it('warns under 5 GB', () => { expect(checkFreeSpace(3 * GB, 'x').level).toBe('warn'); });
  it('is ok at 5 GB and above', () => { expect(checkFreeSpace(5 * GB, 'x').level).toBe('ok'); });
});

describe('checkWritable', () => {
  it('is ok for a writable dir and leaves nothing behind', () => {
    const d = mkdtempSync(join(tmpdir(), 'w-'));
    expect(checkWritable(d, 'blobs').level).toBe('ok');
    expect(readdirSync(d)).toEqual([]);
  });
  it.skipIf(process.getuid?.() === 0)('fails with the chown command for a read-only dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'w-'));
    chmodSync(d, 0o500);
    const r = checkWritable(d, 'blobs');
    expect(r.level).toBe('fail');
    expect(r.message).toMatch(/blobs is not writable by uid \d+: run sudo chown -R 1000:1000 "\$WEBADF_DATA_DIR\/blobs"/);
  });
});

describe('checkPgData', () => {
  it('is ok for an empty folder (first start) and for an 18 cluster', () => {
    expect(checkPgData([], false).level).toBe('ok');
    expect(checkPgData(['18'], false).level).toBe('ok');
  });
  it('fails for another major version directory', () => {
    const r = checkPgData(['17'], false);
    expect(r.level).toBe('fail');
    expect(r.message).toMatch(/data\/postgres holds a Postgres 17 cluster but the image is Postgres 18 -- see docs\/self-hosting\.md, "Postgres major upgrade"/);
  });
  it('fails for a pre-18 layout (PG_VERSION directly in data/postgres/data)', () => {
    expect(checkPgData(['data'], true).level).toBe('fail');
  });
});
