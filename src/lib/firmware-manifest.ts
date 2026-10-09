/**
 * The exact bytes a release's signature covers (spec D4). The firmware builds
 * the same string in fw_verify.c; test/fw_fixture.h proves they agree.
 * Changing a single character here strands every board in the field.
 */
export const FIRMWARE_MAX_BYTES = 2 * 1024 * 1024;

export function firmwareManifest(m: { version: string; sequence: number; sha256: string; sizeBytes: number }): string {
  return `webadf-fw-v1\n${m.version}\n${m.sequence}\n${m.sha256}\n${m.sizeBytes}`;
}

/**
 * Spec D10: the one packaging mistake that removes the safety net is a release
 * without TBYB -- it boots unconditionally on update and can never revert. A
 * machine checks it, from picotool's own reading of the image.
 */
export function refuseReleaseImage(picotoolInfo: string, sizeBytes: number, bytes: Buffer, notes: string | null = null): string | null {
  if (sizeBytes > FIRMWARE_MAX_BYTES) return `image is ${sizeBytes} bytes; the limit is 2 MB`;
  if (!/^\s*tbyb:\s+not bought\s*$/m.test(picotoolInfo)) {
    return 'image is not a TBYB (try-before-you-buy) image; build with PICO_CRT0_IMAGE_TYPE_TBYB=1';
  }
  // Exact line match, not a substring search: /hash/i also matched a path
  // that merely contained the word, and matched picotool's own "hash:
  // incorrect" -- printed for a PATCHED image whose hash the boot ROM would
  // then also reject, which is exactly the image this check exists to catch.
  if (!/^\s*hash:\s+verified\s*$/m.test(picotoolInfo)) {
    return 'image carries no hash for the boot ROM to check; build with pico_hash_binary';
  }
  if (bytes.includes(Buffer.from('fwdbg', 'ascii'))) return 'image contains the debug-only firmware command (WF_FW_DEBUG)';
  // A build with DF1 on by default (WF_DF1_DEFAULT) carries this marker (drive_store.c).
  // It is for bench TEST builds; the operator says so in the notes.
  if (bytes.includes(Buffer.from('wf-df1-default-on', 'ascii')) && !(notes ?? '').startsWith('TEST build')) {
    return 'image has DF1 on by default (WF_DF1_DEFAULT); publish it only as a bench build, with --notes starting "TEST build"';
  }
  return null;
}

/**
 * The registry (and so the over-the-air channel) takes wifi_floppy.bin and
 * nothing else. In particular never wifi_floppy_install.bin: it is the same
 * firmware WITHOUT TBYB, made only to ride inside the drag-and-drop install
 * UF2. refuseReleaseImage would refuse it too (no "tbyb: not bought" line);
 * this makes the path itself a second, independent guard.
 */
export function refuseRegistryArtifact(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  if (name !== 'wifi_floppy.bin') {
    return `only wifi_floppy.bin is ever published to the registry, not ${name}`
      + (/install/i.test(name) ? ' (the install image is USB-only and has no TBYB)' : '');
  }
  return null;
}

/**
 * The image inside the first-install UF2 must be the opposite of a release
 * image in one respect: NOT TBYB. An absolute UF2's post-download reboot never
 * starts a TBYB image, so a TBYB image there leaves the board in BOOTSEL
 * (research 2026-10-09 §1). It still needs the hash the boot ROM checks.
 */
export function refuseInstallImage(picotoolInfo: string): string | null {
  if (/^\s*tbyb:/m.test(picotoolInfo)) {
    return 'the install image is TBYB; it must be wifi_floppy_install.bin (PICO_CRT0_IMAGE_TYPE_TBYB off)';
  }
  if (!/^\s*hash:\s+verified\s*$/m.test(picotoolInfo)) {
    return 'the install image carries no hash for the boot ROM to check';
  }
  return null;
}

// picobin (pico-sdk boot/picobin.h): the metadata blocks the boot ROM reads.
const PICOBIN_START = 0xffffded3;
const PICOBIN_END = 0xab123579;
const ITEM_IMAGE_TYPE = 0x42;
const ITEM_HASH_VALUE = 0x4b;
const ITEM_LAST = 0xff;
const IMAGE_TYPE_TBYB = 0x8000;

interface PicobinItem { type: number; offset: number; words: number }
interface PicobinBlock { start: number; items: PicobinItem[] }

function parseBlock(img: Buffer, start: number): { block: PicobinBlock; link: number } | null {
  if (start < 0 || start + 4 > img.length || img.readUInt32LE(start) !== PICOBIN_START) return null;
  const items: PicobinItem[] = [];
  let p = start + 4;
  while (p + 4 <= img.length && p - start < 0x280) {
    const w = img.readUInt32LE(p);
    const type = w & 0xff;
    const words = (type & 0x80) ? (w >>> 8) & 0xffff : (w >>> 8) & 0xff;
    if (type === ITEM_LAST) {
      if (p + 12 > img.length || img.readUInt32LE(p + 8) !== PICOBIN_END) return null;
      return { block: { start, items }, link: img.readInt32LE(p + 4) };
    }
    if (words === 0) return null;
    items.push({ type, offset: p, words });
    p += words * 4;
  }
  return null;
}

/** The image's block loop: the first block within its first 4 KB, then each link until it closes. */
export function picobinBlockLoop(img: Buffer): PicobinBlock[] | null {
  for (let first = 0; first + 4 <= Math.min(img.length, 4096); first += 4) {
    const head = parseBlock(img, first);
    if (!head) continue;
    const loop = [head.block];
    let next = first + head.link;
    while (next !== first) {
      if (loop.length > 16) return null;
      const b = parseBlock(img, next);
      if (!b) return null;
      loop.push(b.block);
      next = next + b.link;
    }
    return loop;
  }
  return null;
}

/**
 * Review I1: the install image (wifi_floppy_install.bin) must be the release
 * image with ONLY the TBYB bit cleared -- and therefore a different hash.
 * Every other byte must match, so a stale build, a debug build (WF_FW_DEBUG)
 * or a DF1-default build can never ride inside the install UF2 beside a clean
 * release. The allowed bytes are found structurally, in the block loop: the
 * flags half of every IMAGE_TYPE item and the data of every HASH_VALUE item --
 * never fixed offsets, which move with the image size.
 */
export function refuseInstallImageMismatch(release: Buffer, install: Buffer): string | null {
  if (release.length !== install.length) {
    return `the install image is ${install.length} bytes, the release image ${release.length}; build both from one tree`;
  }
  const a = picobinBlockLoop(release);
  const b = picobinBlockLoop(install);
  if (!a || !b) return 'could not read the picobin block loop of both images';
  const shape = (l: PicobinBlock[]) => JSON.stringify(l.map((x) => [x.start, x.items.map((i) => [i.type, i.offset, i.words])]));
  if (shape(a) !== shape(b)) return 'the two images have different metadata block layouts';
  const allowed = new Set<number>();
  let imageTypes = 0;
  let hashes = 0;
  for (const block of a) {
    for (const item of block.items) {
      if (item.type === ITEM_IMAGE_TYPE) {
        const rf = release.readUInt16LE(item.offset + 2);
        const inf = install.readUInt16LE(item.offset + 2);
        if (!(rf & IMAGE_TYPE_TBYB)) return 'the release image is not TBYB';
        if (inf !== (rf & ~IMAGE_TYPE_TBYB)) {
          return `the install image's IMAGE_TYPE flags are 0x${inf.toString(16)}, expected 0x${(rf & ~IMAGE_TYPE_TBYB).toString(16)} (the release's minus TBYB)`;
        }
        allowed.add(item.offset + 2); allowed.add(item.offset + 3);
        imageTypes++;
      } else if (item.type === ITEM_HASH_VALUE) {
        for (let o = item.offset + 4; o < item.offset + item.words * 4; o++) allowed.add(o);
        hashes++;
      }
    }
  }
  if (imageTypes === 0 || hashes === 0) return 'the images carry no IMAGE_TYPE or no HASH_VALUE item';
  for (let i = 0; i < release.length; i++) {
    if (release[i] !== install[i] && !allowed.has(i)) {
      return `the install image differs from the release image at byte 0x${i.toString(16)}, outside the TBYB flag and the hash; rebuild both from one tree`;
    }
  }
  return null;
}
