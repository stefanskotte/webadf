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
  | { publish: true; tag: string; title: string; body: string; manifest: Record<string, unknown> };

/** A TEST build is bench-only and never a public download. */
export function isTestBuild(notes: string | null): boolean {
  return notes !== null && /^TEST build/.test(notes);
}

export function githubReleasePlan(r: GithubReleaseInput): GithubReleasePlan {
  if (isTestBuild(r.notes)) return { publish: false, reason: 'TEST build: never published to GitHub' };
  if (!/^\d+\.\d+\.\d+$/.test(r.semver)) return { publish: false, reason: `not a release semver: ${r.semver}` };
  const tag = `fw-${r.semver}`;
  const body = [
    `wifi-floppy firmware ${r.version} (sequence ${r.sequence}).`,
    '',
    ...(r.notes ? [r.notes, ''] : []),
    'These are the same signed files the web app installs over the air.',
    'manifest.json carries the version, sequence, size, sha256 and the ed25519 signature of wifi_floppy.bin.',
  ].join('\n');
  return {
    publish: true,
    tag,
    title: `Firmware ${r.semver}`,
    body,
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
