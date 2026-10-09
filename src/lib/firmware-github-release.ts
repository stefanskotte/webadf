// The GitHub release for a published firmware version (operator, 2026-10-09):
// the download page shows exactly the signed bytes the web app offers over the
// air, never a separately built copy. `pnpm firmware:publish` is the only
// writer; the firmware workflow builds and tests but releases nothing.
//
// Pure decisions here (tested); scripts/firmware-release.ts does the I/O.

export interface GithubReleaseInput {
  version: string;        // the full build string, e.g. 1.8.1+g1f343d5
  semver: string;         // 1.8.1
  sequence: number;       // the registry sequence
  sha256: string;         // of wifi_floppy.bin, as signed
  signature: string;      // base64 ed25519 over the registry manifest
  signingKeyId: string;
  notes: string | null;   // the registry notes
}

export type GithubReleasePlan =
  | { publish: false; reason: string }
  | {
      publish: true; tag: string; title: string; body: string; manifest: Record<string, unknown>;
      /** The release asset name of the single drag-and-drop first-install UF2. */
      installAsset: string;
    };

/**
 * The first-install UF2 (research 2026-10-09 §6): the partition table plus a
 * NON-TBYB build of the same commit, all in the absolute UF2 family. The
 * build writes it as wifi-floppy-install.uf2; the release names it by semver.
 * It is a USB-only file -- never the OTA image (refuseRegistryArtifact).
 */
export const INSTALL_UF2_BUILD_NAME = 'wifi-floppy-install.uf2';
export function installAssetName(semver: string): string {
  return `wifi-floppy-install-${semver}.uf2`;
}

/** A TEST build is bench-only and never a public download. */
export function isTestBuild(notes: string | null): boolean {
  return notes !== null && /^TEST build/.test(notes);
}

export function githubReleasePlan(r: GithubReleaseInput): GithubReleasePlan {
  if (isTestBuild(r.notes)) return { publish: false, reason: 'TEST build: never published to GitHub' };
  if (!/^\d+\.\d+\.\d+$/.test(r.semver)) return { publish: false, reason: `not a release semver: ${r.semver}` };
  const tag = `fw-${r.semver}`;
  const installAsset = installAssetName(r.semver);
  const body = [
    `wifi-floppy firmware ${r.version} (sequence ${r.sequence}).`,
    '',
    ...(r.notes ? [r.notes, ''] : []),
    // INSTALL_PENDING_MARKER: remove "(bench-verification pending)" once the
    // operator's bench run of the drag-and-drop install has passed.
    `First install (bench-verification pending): hold BOOTSEL, plug the board into USB, and drag ${installAsset}`,
    'onto the drive that appears. The board writes everything it needs and restarts into this firmware by itself;',
    'then pair it from the web app. Later versions arrive over the air. No picotool is needed.',
    '',
    `${installAsset} is a USB-only build of the same commit without the try-before-you-buy flag; it is never offered over the air.`,
    'wifi_floppy.bin, wifi_floppy.uf2 and wifi_floppy_pt.uf2 are the same signed files the web app installs over the air.',
    'manifest.json carries the version, sequence, size, sha256 and the ed25519 signature of wifi_floppy.bin.',
  ].join('\n');
  return {
    publish: true,
    tag,
    title: `Firmware ${r.semver}`,
    body,
    installAsset,
    manifest: {
      version: r.version,
      semver: r.semver,
      sequence: r.sequence,
      file: 'wifi_floppy.bin',
      sha256: r.sha256,
      signature: r.signature,
      signingKeyId: r.signingKeyId,
      signatureFormat: 2,
    },
  };
}

/**
 * The bytes about to be attached must be the registry's: a rebuild between
 * the publish and the upload (or the wrong build directory) would put files
 * on GitHub that no board was ever offered.
 */
export function assertSameBytes(registrySha256: string, builtSha256: string): void {
  if (registrySha256 !== builtSha256) {
    throw new Error(
      `the built wifi_floppy.bin (sha256 ${builtSha256}) is not the published one (${registrySha256}); `
      + 'rebuild exactly the published commit before attaching it to GitHub',
    );
  }
}

const UF2_MAGIC0 = 0x0a324655;
const UF2_MAGIC1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const UF2_FAMILY_ABSOLUTE = 0xe48bff57;
const XIP_BASE = 0x10000000;
const FLASH_BYTES = 16 * 1024 * 1024;
/** The top five 4 KB sectors: token, config, fw_state, display, drive_store. */
const RECORDS_START = XIP_BASE + FLASH_BYTES - 5 * 4096;

/**
 * A last look at the install UF2 before it goes on a release page, so a stale
 * or wrong file never ships: every block absolute-family and inside the flash
 * below the settings sectors (so a drag never touches a board's token, Wi-Fi
 * or pairing), and the image it carries is the one this release names.
 * tools/make_install_uf2.py already refuses all of this; this is the second,
 * independent reader. Returns null when it is fine, else why not.
 */
export function checkInstallUf2(uf2: Buffer, version: string): string | null {
  if (uf2.length === 0 || uf2.length % 512 !== 0) return 'not a UF2 (length is not a multiple of 512)';
  const blocks = uf2.length / 512;
  const payload: Buffer[] = [];
  for (let i = 0; i < blocks; i++) {
    const o = i * 512;
    if (uf2.readUInt32LE(o) !== UF2_MAGIC0 || uf2.readUInt32LE(o + 4) !== UF2_MAGIC1
      || uf2.readUInt32LE(o + 508) !== UF2_MAGIC_END) return `block ${i}: bad UF2 magic`;
    const addr = uf2.readUInt32LE(o + 12);
    const size = uf2.readUInt32LE(o + 16);
    if (uf2.readUInt32LE(o + 20) !== i || uf2.readUInt32LE(o + 24) !== blocks) return `block ${i}: numbering is inconsistent`;
    if (uf2.readUInt32LE(o + 28) !== UF2_FAMILY_ABSOLUTE) return `block ${i}: not in the absolute UF2 family`;
    if (size > 476) return `block ${i}: payload size ${size}`;
    if (addr < XIP_BASE || addr + size > RECORDS_START) {
      return `block ${i} writes 0x${addr.toString(16)}: outside the flash or inside the top-of-flash settings sectors`;
    }
    payload.push(uf2.subarray(o + 32, o + 32 + size));
  }
  if (!Buffer.concat(payload).includes(Buffer.from(version, 'ascii'))) {
    return `the image inside does not carry the version ${version}; rebuild before attaching it`;
  }
  return null;
}
