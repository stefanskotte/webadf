/**
 * Verify src/lib/archive/dms.ts against the implementation it was ported FROM.
 *
 *   pnpm dms:verify <directory-of-.dms-files> [path-to-xdms]
 *
 * Every .dms in the directory is decoded by this repository's reader and by
 * the real xDMS, and the two 901,120-byte images are compared byte for byte.
 * Same arrangement as `pnpm lha:verify` (lha), `pnpm adffs:verify` (xdftool)
 * and `pnpm adfmfm:diff` (greaseweazle), for the same reason: our decoder
 * agreeing with our own fixtures proves only that both were written by the
 * same misunderstanding. There is no published DMS specification -- xDMS IS
 * the specification -- so agreeing with it is the only meaningful test.
 *
 * Deliberately NOT part of `pnpm test`: it needs the xdms binary and real
 * archives, which are third-party files this repository should not carry.
 * xDMS is public domain and builds from Aminet's util/arc/xDMS.lha; it needs
 * `-std=gnu89`, because its `INLINE` expands to bare `inline` and C99 emits no
 * definition for that.
 *
 * WHAT THIS ARRANGEMENT CAUGHT, none of which a unit fixture could have:
 *   * DMS carries decoder state ACROSS tracks -- the LZ history buffer, every
 *     write cursor, HEAVY's Huffman trees and DEEP's adaptive tree all persist
 *     unless a per-track flag clears them. A port that resets per track
 *     decodes track 0 perfectly and nothing after it.
 *   * xDMS's own read_tree_p writes up to 31 entries into a 20-entry array.
 *     Real archives reach it: 8 of the first 33 tracks tested asked for 21-26.
 *     That is undefined behaviour, so this port refuses such a stream rather
 *     than reproducing a crash it cannot reproduce faithfully anyway.
 *
 * WHAT IS STILL NOT COVERED, stated because a verifier that overstates itself
 * is worse than none: HEAVY1's 4 KB dictionary. No real archive found uses
 * HEAVY1 (DMS chose HEAVY2 by default), and HEAVY1 and HEAVY2 differ only for
 * matches 4096 bytes or further back, which no available stream produces. The
 * constant is taken verbatim from the reference.
 *
 * Prove it can fail before trusting it: corrupt a byte in one archive and this
 * must report DIFFER, not pass.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDms } from '../src/lib/archive/dms';

const dir = process.argv[2];
const xdms = process.argv[3] ?? 'xdms';
if (!dir || !existsSync(dir)) {
  console.error('usage: pnpm dms:verify <directory-of-.dms-files> [path-to-xdms]');
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => /\.dms$/i.test(f)).sort();
if (files.length === 0) {
  // A verifier that passes having verified nothing is worse than no verifier:
  // it reports success. lha-verify shipped with exactly this hole.
  console.error(`no .dms files in ${dir} -- nothing was verified`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'dmsverify-'));
let ok = 0, bad = 0, agreedRefused = 0;
try {
  for (const f of files) {
    const src = new Uint8Array(readFileSync(join(dir, f)));
    const mine = readDms(src);

    const refPath = join(work, `${f}.adf`);
    let ref: Uint8Array | null = null;
    try {
      execFileSync(xdms, ['-q', 'u', join(dir, f), `+${refPath}`], { stdio: 'pipe' });
      ref = new Uint8Array(readFileSync(refPath));
    } catch {
      ref = null;
    }

    if (!ref) {
      // The reference refusing is a result, not a skip: this reader must not
      // cheerfully accept what xDMS rejects.
      console.log(`${f.padEnd(28)} xdms REFUSED  ours=${mine.ok ? 'ACCEPTED (suspicious)' : 'refused'}`);
      if (mine.ok) bad++; else agreedRefused++;
      continue;
    }
    if (!mine.ok) { console.log(`${f.padEnd(28)} FAIL  ${mine.reason}`); bad++; continue; }

    let at = -1;
    if (ref.length !== mine.adf.length) at = -2;
    else for (let i = 0; i < ref.length; i++) if (ref[i] !== mine.adf[i]) { at = i; break; }
    if (at === -1) { console.log(`${f.padEnd(28)} match   ${mine.info.modes.join('+')}`); ok++; }
    else { console.log(`${f.padEnd(28)} DIFFER  at ${at === -2 ? 'length' : `byte ${at}`}`); bad++; }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Counted separately on purpose. A corrupted archive that BOTH implementations
// refuse is agreement, but it is not a byte-for-byte comparison, and a summary
// that folds the two together reports a decoder as verified by files it never
// decoded -- the same hole lha-verify shipped with (0/0, exit 0).
console.log(`\n${ok}/${files.length} archives decoded and matched xDMS byte for byte` +
            (agreedRefused ? `; ${agreedRefused} refused by both` : ''));
if (ok === 0) {
  console.error('NOTHING was actually decoded -- this run verified nothing');
  process.exit(2);
}
process.exit(bad === 0 ? 0 : 1);
