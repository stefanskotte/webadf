import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePgDir, ensureTraversable } from './pgdir';

const mode = (p: string) => statSync(p).mode & 0o7777;
const tmp = () => mkdtempSync(join(tmpdir(), 'pg-'));

describe('preparePgDir', () => {
  it('creates 18/ and sets both dirs to 0755 even when they lack execute for other', () => {
    const pg = join(tmp(), 'postgres');
    mkdirSync(pg);
    chmodSync(pg, 0o766);
    mkdirSync(join(pg, '18'));
    chmodSync(join(pg, '18'), 0o700);
    preparePgDir(pg);
    expect(mode(pg)).toBe(0o755);
    expect(mode(join(pg, '18'))).toBe(0o755);
  });
  it('creates a missing 18/', () => {
    const pg = join(tmp(), 'postgres');
    mkdirSync(pg);
    chmodSync(pg, 0o700);
    preparePgDir(pg);
    expect(existsSync(join(pg, '18'))).toBe(true);
    expect(mode(join(pg, '18'))).toBe(0o755);
  });
  it('leaves an existing 18/docker at 0700', () => {
    const pg = join(tmp(), 'postgres');
    mkdirSync(join(pg, '18/docker'), { recursive: true });
    chmodSync(join(pg, '18/docker'), 0o700);
    preparePgDir(pg);
    expect(mode(join(pg, '18/docker'))).toBe(0o700);
  });
});

describe('ensureTraversable', () => {
  it('adds only the execute bits', () => {
    const d = tmp();
    chmodSync(d, 0o640);
    ensureTraversable(d);
    expect(mode(d)).toBe(0o751);
  });
  it('does not loosen anything else, nor touch a dir that already has them', () => {
    const d = tmp();
    chmodSync(d, 0o700);
    ensureTraversable(d);
    expect(mode(d)).toBe(0o711);
    chmodSync(d, 0o750 | 0o001);
    ensureTraversable(d);
    expect(mode(d)).toBe(0o751);
  });
});
