/**
 * Verify src/lib/archive against an INDEPENDENT implementation.
 *
 *   pnpm lha:verify <directory-of-archives>
 *
 * Every .lha in the directory is read by our reader and extracted by the real
 * `lha`, and every byte of every member is compared. This is the same
 * arrangement as `pnpm adffs:verify` (xdftool) and `pnpm adfmfm:diff`
 * (greaseweazle), and exists for the same reason: our reader agreeing with our
 * own fixtures proves only that they were built by the same misunderstanding.
 *
 * Deliberately NOT part of `pnpm test`. It needs the `lha` binary and it needs
 * real archives, which are third-party files this repository should not carry.
 * Point it at a directory of Aminet downloads.
 *
 * WHAT IT CAUGHT, the first time it was run against real archives -- neither
 * of which the unit fixtures could have found:
 *   * level 1's extended-header chain stores each header's size at the END of
 *     the previous one. Getting that wrong decodes levels 0 and 2 correctly by
 *     luck and lands level 1's payload 26 bytes early: files of exactly the
 *     right LENGTH, full of the wrong bytes.
 *   * level 0/1 headers pack the file comment into the filename field as
 *     "name\0comment", so Aminet's l2boot.lha produced perfect bytes under
 *     unusable names.
 *
 * Prove it can fail before trusting it: corrupt a byte in one archive and this
 * must report DIFFER, not pass.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLha } from '../src/lib/archive/lha';

const LHA = '/opt/homebrew/bin/lha';

function walk(dir: string, base = ''): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, `${base}${f}/`) : [`${base}${f}`];
  });
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: pnpm lha:verify <directory-of-archives>');
  process.exit(2);
}

// existsSync, not a trial invocation: this build of lha exits non-zero on an
// unrecognised flag, so probing with `-h` reported the tool as absent when it
// was installed and working.
if (!existsSync(LHA)) {
  // An absent reference tool must FAIL, not quietly pass: a verifier that
  // reports success when it verified nothing is worse than no verifier.
  console.error(`lha:verify: ${LHA} not found — install it (brew install lha).`);
  process.exit(2);
}

const archives = readdirSync(dir).filter((f) => /\.lha$/i.test(f)).sort();
if (archives.length === 0) {
  console.error(`lha:verify: no .lha files in ${dir}`);
  process.exit(2);
}

let okTotal = 0;
let fileTotal = 0;
let failures = 0;

for (const arc of archives) {
  const path = join(dir, arc);
  const { entries, skipped } = readLha(new Uint8Array(readFileSync(path)));

  const ref = mkdtempSync(join(tmpdir(), 'lhaverify-'));
  try {
    execFileSync(LHA, ['x', '-q', `-w=${ref}`, path], { stdio: 'ignore' });
  } catch {
    console.log(`${arc}: the reference tool itself refused this archive — skipped`);
    rmSync(ref, { recursive: true, force: true });
    continue;
  }

  const refFiles = walk(ref).sort();
  const problems: string[] = [];
  let ok = 0;

  for (const rel of refFiles) {
    const mine = entries.find((e) => e.path === rel);
    if (!mine) { problems.push(`MISSING ${rel}`); continue; }
    const want = new Uint8Array(readFileSync(join(ref, rel)));
    if (Buffer.compare(Buffer.from(mine.bytes), Buffer.from(want)) !== 0) {
      problems.push(`DIFFER ${rel} (ours ${mine.bytes.length}, lha ${want.length})`);
    } else ok++;
  }
  // Members we produced that the reference did not is just as wrong as the
  // reverse, and is what a runaway header walk looks like.
  for (const e of entries) {
    if (!refFiles.includes(e.path)) problems.push(`EXTRA ${e.path}`);
  }
  rmSync(ref, { recursive: true, force: true });

  okTotal += ok;
  fileTotal += refFiles.length;
  if (problems.length > 0) failures++;

  const methods = [...new Set(entries.map((e) => e.method))].sort().join(',');
  const prot = entries.filter((e) => e.protection !== null).length;
  console.log(
    `${arc.padEnd(26)} ${String(ok).padStart(4)}/${String(refFiles.length).padEnd(4)} ` +
    `methods=${methods.padEnd(14)} protbits=${prot}/${entries.length}` +
    (skipped.length > 0 ? `  skipped=${JSON.stringify(skipped)}` : '') +
    (problems.length > 0 ? `\n    ${problems.slice(0, 6).join('\n    ')}` : ''),
  );
}

console.log(`\n${okTotal}/${fileTotal} members byte-identical across ${archives.length} archive(s)`);

// VERIFYING NOTHING IS NOT PASSING. Every archive being skipped -- because the
// reference tool refused them all, say -- used to print "0/0" and exit 0,
// which is the same lie as a missing binary reporting success. Caught by
// mutation-testing this script: corrupting an archive made `lha` reject it,
// and the verifier called that a pass.
if (fileTotal === 0) {
  console.error('lha:verify: nothing was actually compared — refusing to report success.');
  process.exit(1);
}
if (failures > 0) {
  console.error(`${failures} archive(s) did not match.`);
  process.exit(1);
}
