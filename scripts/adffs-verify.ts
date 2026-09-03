/*
 * Cross-check formatVolume() against an INDEPENDENT implementation.
 *
 * Same idea as `pnpm adfmfm:diff`, which checks the MFM encoder against
 * Greaseweazle, and it exists for a sharper reason here: this repo's own
 * reader deliberately ignores the bitmap, so a disk with a completely wrong
 * bitmap round-trips through readVolume perfectly and only corrupts when a
 * real Amiga writes to it. Unit tests cannot catch that class of bug, because
 * the code that would catch it is the code under test.
 *
 * amitools' xdftool is the second opinion. The decisive step is not that it
 * READS our disk -- it is that it WRITES a file into one, which means it
 * allocated a block out of our bitmap and believed it.
 *
 * Not part of `pnpm test`: xdftool is not a dependency of this project and is
 * not installed in CI. Run it by hand after touching format.ts.
 *
 *   brew install amitools   # or: pipx install amitools
 *   pnpm adffs:verify
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatVolume } from '../src/lib/adffs/format';
import { readVolume } from '../src/lib/adffs';

const dir = mkdtempSync(join(tmpdir(), 'adffs-verify-'));
let failures = 0;

function xdftool(image: string, ...args: string[]): string {
  return execFileSync('xdftool', [image, ...args], { encoding: 'utf8' });
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

try {
  execFileSync('xdftool', ['--help'], { stdio: 'ignore' });
} catch {
  console.error('xdftool not found. brew install amitools (or pipx install amitools).');
  process.exit(2);
}

for (const filesystem of ['OFS', 'FFS'] as const) {
  console.log(`\n${filesystem}`);
  const name = `Ours${filesystem}`;
  const image = join(dir, `ours-${filesystem}.adf`);
  writeFileSync(image, formatVolume({ filesystem, volumeName: name }));

  const info = xdftool(image, 'info');
  // A blank disk is 4 blocks: two boot blocks, the root and the bitmap. The
  // boot blocks are not bits in the bitmap, so this number checks our
  // arithmetic against theirs rather than against itself.
  check('xdftool reports 4 blocks used', /used:\s+4\b/.test(info), info.split('\n')[1]?.trim());
  check('xdftool reports 1756 free', /free:\s+1756\b/.test(info), info.split('\n')[2]?.trim());

  const list = xdftool(image, 'list');
  check('volume name and filesystem recognised',
    list.includes(name) && list.includes(filesystem === 'FFS' ? 'ffs' : 'ofs'),
    list.split('\n')[0]?.trim());

  // THE ONE THAT MATTERS. Writing means xdftool allocated a block out of our
  // bitmap. A bitmap that is wrong in the safe direction (everything marked
  // used) makes this fail; wrong in the dangerous direction (everything free)
  // makes it silently overwrite the root or the bitmap itself, which the
  // re-read below then catches.
  const payload = join(dir, 'HELLO');
  writeFileSync(payload, 'hello from the verifier\n');
  xdftool(image, 'write', payload);
  const after = xdftool(image, 'list');
  check('xdftool can write a file into our disk', after.includes('HELLO'));

  const reread = readVolume(new Uint8Array(readFileSync(image)));
  check('our reader still reads it after their write',
    reread.ok && reread.root.some((e) => e.name === 'HELLO'),
    reread.ok ? `entries=[${reread.root.map((e) => e.name).join(', ')}]` : `reason=${reread.reason}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
