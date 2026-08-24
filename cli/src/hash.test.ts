import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from './hash';

describe('hashFile', () => {
  it('produces the known sha-256 of an empty file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webadf-'));
    const f = join(dir, 'empty.adf');
    writeFileSync(f, '');
    await expect(hashFile(f)).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is stable across calls and lowercase hex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webadf-'));
    const f = join(dir, 'x.adf');
    writeFileSync(f, 'hello');
    const a = await hashFile(f);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashFile(f)).toBe(a);
  });
});
