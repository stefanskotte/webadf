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
import { syntheticVolume, type SyntheticOptions } from '../src/lib/adffs/synthetic';
import { ROOT_BLOCK } from '../src/lib/adffs/constants';
import { addFile, deleteEntry, renameEntry, replaceFile, makeDirectory } from '../src/lib/adffs/write';

const dir = mkdtempSync(join(tmpdir(), 'adffs-verify-'));
let failures = 0;

/**
 * On failure, execFileSync's thrown Error carries xdftool's actual output
 * (an "FSError: ..." line) on `.stdout`, NOT in the Error's own message --
 * `String(e)` on the raw throw is just "Command failed: xdftool ...". Every
 * caller here (including the synthetic-fixtures checks below) tests the
 * caught value against /FSError/, so that text has to survive the throw or
 * the check silently never fires. Re-thrown with stdout as the message so
 * `String(e)` in every `catch` block actually contains it.
 */
function xdftool(image: string, ...args: string[]): string {
  try {
    return execFileSync('xdftool', [image, ...args], { encoding: 'utf8' });
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout;
    throw new Error(stdout || String(e));
  }
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

console.log('\nsynthetic fixtures');
const payload = join(dir, 'payload.bin');
writeFileSync(payload, 'hello from the synthetic verifier\n');
const syntheticFixtures: [string, SyntheticOptions][] = [
  ['OFS file',   { filesystem: 'OFS', volumeName: 'SynOFS',  entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hello amiga') }] }],
  ['FFS file',   { filesystem: 'FFS', volumeName: 'SynFFS',  entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hello amiga') }] }],
  ['FFS INTL',   { filesystem: 'FFS', intl: true, volumeName: 'SynINTL', entries: [{ name: 'hello.txt', bytes: new TextEncoder().encode('hi') }] }],
  ['FFS nested', { filesystem: 'FFS', volumeName: 'SynDir',  entries: [{ name: 'sub', entries: [{ name: 'in.txt', bytes: new TextEncoder().encode('nested') }] }] }],
];
for (const [label, opts] of syntheticFixtures) {
  const image = join(dir, `syn-${label.replace(/\W/g, '')}.adf`);
  writeFileSync(image, syntheticVolume(opts));
  let listed = '';
  try { listed = xdftool(image, 'list'); } catch (e) { listed = String(e); }
  check(`xdftool opens the ${label} fixture`, !/FSError/.test(listed), listed.split('\n')[0]);
  // The decisive one, same as for formatVolume: can they ALLOCATE into it?
  let wrote = true;
  try { xdftool(image, 'write', payload, 'added.txt'); } catch { wrote = false; }
  check(`xdftool writes into the ${label} fixture`, wrote);
}

// ---------------------------------------------------------------------------
// Task 9: every write operation, proved against xdftool.
//
// Unit tests structurally cannot judge the bitmap: the code that would
// judge it is the code under test. xdftool is the independent second
// opinion, and the decisive step per operation is never that it READS our
// disk -- it is that it WRITES into one afterwards, which only succeeds if
// it allocated a block out of OUR bitmap and believed it.

/**
 * Round-trip one operation's result through xdftool. Returns the temp image
 * path so a caller can run further checks (e.g. confirming a deleted name
 * is really gone) against the same file.
 */
function proves(label: string, adf: Uint8Array, expectNames: string[]): string {
  const image = join(dir, `${label.replace(/\W/g, '')}.adf`);
  writeFileSync(image, adf);

  let listing = '';
  try { listing = xdftool(image, 'list'); } catch (e) { listing = String(e); }
  check(`${label}: xdftool lists it`, !/FSError/.test(listing));
  for (const n of expectNames) {
    check(`${label}: xdftool sees ${n}`, listing.toUpperCase().includes(n.toUpperCase()));
  }

  // THE ONE THAT MATTERS: they allocate out of OUR bitmap and believe it.
  const writePayload = join(dir, 'theirs.txt');
  writeFileSync(writePayload, 'written by xdftool\n');
  let wrote = true;
  try { xdftool(image, 'write', writePayload, 'theirs.txt'); } catch { wrote = false; }
  check(`${label}: xdftool writes into it`, wrote);

  // ...and we can still read the disk after their write.
  const back = readVolume(new Uint8Array(readFileSync(image)));
  check(`${label}: our reader still reads it`, back.ok, back.ok ? '' : `reason=${back.reason}`);
  return image;
}

/** The block number of a root-level entry, by name (case-insensitive). */
function blockOf(adf: Uint8Array, name: string): number {
  const v = readVolume(adf);
  if (!v.ok) throw new Error(`setup: cannot read volume looking for ${name} (reason=${v.reason})`);
  const entry = v.root.find((e) => e.name.toUpperCase() === name.toUpperCase());
  if (!entry) throw new Error(`setup: ${name} not found in root (have ${v.root.map((e) => e.name).join(', ')})`);
  return entry.block;
}

const smallPayload = new TextEncoder().encode('hello from task 9\n');
// 100 blocks at the smaller of the two per-block sizes (OFS_DATA_BYTES=488)
// still exceeds 72 for FFS too, so both filesystems exercise the extension
// chain, not just one of them.
const largePayload = new Uint8Array(100 * 512).fill(7);

for (const filesystem of ['OFS', 'FFS'] as const) {
  console.log(`\n${filesystem} write operations`);

  {
    const base = formatVolume({ filesystem, volumeName: `Add${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'add.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: add failed (${added.reason})`);
    proves(`${filesystem} add`, added.adf, ['add.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Big${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'big.bin', largePayload);
    if (!added.ok) throw new Error(`setup: add-large failed (${added.reason})`);
    proves(`${filesystem} add-large`, added.adf, ['big.bin']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Ren${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'old.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: rename setup add failed (${added.reason})`);
    const block = blockOf(added.adf, 'old.txt');
    const renamed = renameEntry(added.adf, ROOT_BLOCK, block, 'new.txt');
    if (!renamed.ok) throw new Error(`setup: rename failed (${renamed.reason})`);
    proves(`${filesystem} rename`, renamed.adf, ['new.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Rep${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'replace.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: replace setup add failed (${added.reason})`);
    const block = blockOf(added.adf, 'replace.txt');
    const replaced = replaceFile(added.adf, block, largePayload);
    if (!replaced.ok) throw new Error(`setup: replace failed (${replaced.reason})`);
    proves(`${filesystem} replace`, replaced.adf, ['replace.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Mkd${filesystem}` });
    const made = makeDirectory(base, ROOT_BLOCK, 'sub');
    if (!made.ok) throw new Error(`setup: makeDirectory failed (${made.reason})`);
    proves(`${filesystem} makeDirectory`, made.adf, ['sub']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Aid${filesystem}` });
    const made = makeDirectory(base, ROOT_BLOCK, 'sub');
    if (!made.ok) throw new Error(`setup: add-into-dir mkdir failed (${made.reason})`);
    const dirBlock = blockOf(made.adf, 'sub');
    const added = addFile(made.adf, dirBlock, 'inner.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: add-into-dir add failed (${added.reason})`);
    proves(`${filesystem} add-into-dir`, added.adf, ['sub', 'inner.txt']);
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Del${filesystem}` });
    const added = addFile(base, ROOT_BLOCK, 'gone.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: delete-file setup add failed (${added.reason})`);
    const block = blockOf(added.adf, 'gone.txt');
    const deleted = deleteEntry(added.adf, ROOT_BLOCK, block);
    if (!deleted.ok) throw new Error(`setup: delete-file failed (${deleted.reason})`);
    const image = proves(`${filesystem} delete-file`, deleted.adf, []);
    const listing = xdftool(image, 'list');
    check(`${filesystem} delete-file: gone.txt is really gone`, !listing.toUpperCase().includes('GONE.TXT'));
  }

  {
    const base = formatVolume({ filesystem, volumeName: `Ddr${filesystem}` });
    const made = makeDirectory(base, ROOT_BLOCK, 'doomed');
    if (!made.ok) throw new Error(`setup: delete-dir mkdir failed (${made.reason})`);
    const dirBlock = blockOf(made.adf, 'doomed');
    const added = addFile(made.adf, dirBlock, 'inside.txt', smallPayload);
    if (!added.ok) throw new Error(`setup: delete-dir add failed (${added.reason})`);
    const deleted = deleteEntry(added.adf, ROOT_BLOCK, dirBlock);
    if (!deleted.ok) throw new Error(`setup: delete-dir failed (${deleted.reason})`);
    const image = proves(`${filesystem} delete-dir`, deleted.adf, []);
    const listing = xdftool(image, 'list');
    check(`${filesystem} delete-dir: doomed is really gone`, !listing.toUpperCase().includes('DOOMED'));
    check(`${filesystem} delete-dir: inside.txt is really gone`, !listing.toUpperCase().includes('INSIDE.TXT'));
  }
}

console.log('\nsharpest case: delete then refill');
{
  // Add a file large enough to matter, delete it, then make xdftool write a
  // file that only FITS if those blocks really came back. A wrong free
  // either fails here (blocks never freed -> disk-full) or silently
  // double-allocates over live data (blocks freed but still believed used
  // by something else).
  //
  // Sized deliberately past HALF the disk's free capacity (1756 blocks at
  // format time), not just past the 72-block extension threshold: this
  // file plus its own header and extension blocks come to ~964 blocks, so
  // if `free` never gave them back, the OTHER ~792 blocks genuinely still
  // free would not be enough for xdftool to fit a same-size refill anywhere
  // else on the disk. A "large-ish" file (e.g. 700 blocks, as the brief's
  // pseudocode used) leaves too much spare capacity on an otherwise-empty
  // volume for that to happen -- xdftool would just use different free
  // blocks and this check would pass even with a no-op `free` (confirmed by
  // running the Step 4 mutation below with 700 blocks: it did not fail).
  const base = formatVolume({ filesystem: 'FFS', volumeName: 'Reuse' });
  const big = new Uint8Array(950 * 512).fill(1);
  const added = addFile(base, ROOT_BLOCK, 'big.bin', big);
  if (!added.ok) throw new Error(`setup: reuse add failed (${added.reason})`);
  const v = readVolume(added.adf);
  if (!v.ok) throw new Error(`setup: reuse read failed (${v.reason})`);
  const deleted = deleteEntry(added.adf, ROOT_BLOCK, v.root[0].block);
  if (!deleted.ok) throw new Error(`setup: reuse delete failed (${deleted.reason})`);

  const image = join(dir, 'reuse.adf');
  writeFileSync(image, deleted.adf);
  const bigPayload = join(dir, 'big-payload.bin');
  writeFileSync(bigPayload, big);           // same size as what we freed
  let refilled = true;
  try { xdftool(image, 'write', bigPayload, 'refill.bin'); } catch { refilled = false; }
  check('freed blocks are genuinely reusable by xdftool', refilled);

  const listing = refilled ? xdftool(image, 'list') : '';
  check('refill.bin actually landed', listing.toUpperCase().includes('REFILL.BIN'));

  const back = readVolume(new Uint8Array(readFileSync(image)));
  check('our reader still reads the disk after refill', back.ok, back.ok ? '' : `reason=${back.reason}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
