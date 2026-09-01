import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVolume, type AdfEntry } from './index';

/**
 * The counterpart to adfmfm's Greaseweazle comparison: run the reader over
 * the operator's real archive and assert the figures the design was measured
 * from. If a refactor changes any of these, either the reader regressed or
 * the spec's section 3 is now wrong -- and both are worth stopping for.
 *
 * Skipped when the archive is absent, so a fresh checkout still passes.
 */
const DIR = 'adf-archive';
const present = existsSync(DIR);

describe.skipIf(!present)('the operator archive', () => {
  const files = present
    ? readdirSync(DIR).filter((f) => /\.adf$/i.test(f))
    : [];

  it('reads exactly the disks the design measured', () => {
    let readable = 0, ofs = 0, ffs = 0, intl = 0, dirc = 0;
    let files_ = 0, dirs = 0, maxDepth = 0, cycles = 0;

    // Depth counts directory nesting levels below the root: a file in the
    // root directory is depth 0, and DOpusSets/Storage/4colicons/Tools (the
    // deepest real path in the archive, on DOpus.adf) is depth 4.
    function walk(list: AdfEntry[], depth: number) {
      if (depth > maxDepth) maxDepth = depth;
      for (const e of list) {
        if (e.kind === 'dir') { dirs++; walk(e.children, depth + 1); }
        else files_++;
      }
    }

    for (const f of files) {
      const r = readVolume(new Uint8Array(readFileSync(join(DIR, f))));
      if (!r.ok) continue;
      readable++;
      r.volume.filesystem === 'FFS' ? ffs++ : ofs++;
      if (r.volume.intl) intl++;
      if (r.volume.dirc) dirc++;
      if (r.warnings.some((w) => /cycle/i.test(w))) cycles++;
      walk(r.root, 0);
    }

    // Measured 2026-09-01; see the design doc's section 3.
    expect(files.length).toBe(61);
    expect(readable).toBe(49);
    expect({ ofs, ffs, intl, dirc }).toEqual({ ofs: 25, ffs: 24, intl: 6, dirc: 0 });
    expect(files_).toBe(2430);
    expect(dirs).toBe(427);
    expect(maxDepth).toBe(4);
    expect(cycles).toBe(0);
  });
});
