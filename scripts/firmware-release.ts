/**
 * Signs and publishes an already-built firmware image (spec §3.4).
 *
 * The version is read out of the GENERATED HEADER, never from an argument, so
 * the published version is by construction the one inside the image. Passing
 * it in would reintroduce exactly the drift this increment removed.
 *
 * It writes to the registry through publishRelease() rather than through an
 * admin HTTP route, because such a route is guarded by a session cookie and
 * there is no honest way to hand a CLI one. This script already needs
 * DATABASE_URL and BLOB_READ_WRITE_TOKEN -- strictly more authority than the
 * route would grant -- so routing through HTTP would add a hop and an auth
 * problem without adding a control.
 *
 * The artifact is the raw `.bin`, not the `.uf2`: picotool reads it directly
 * for the TBYB/hash/debug-command checks (spec D10), and the signature covers
 * a manifest over the same bytes the board downloads and verifies (spec D4),
 * so the published blob and the signed bytes must be identical.
 *
 * Usage:  pnpm firmware:publish [--notes "..."] [--security] [--dry-run] [--no-github] [--github-only]
 *
 * After a release is recorded it is also published as the GitHub release fw-<semver>
 * with the SAME signed wifi_floppy.bin and its manifest (src/lib/firmware-github-release.ts); TEST builds never
 * are. The release also carries wifi-floppy-install-<semver>.uf2, the single
 * drag-and-drop first-install file: the same commit built WITHOUT TBYB, so it is
 * USB-only and never goes to the registry (refuseRegistryArtifact). --github-only (re)attaches an already-published version's files, checked
 * byte-for-byte against the registry; --no-github skips the GitHub step.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFileSync, existsSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { put, head } from '@vercel/blob';
import { getDb } from '@/db';
import { user } from '@/db/schema/auth';
import { firmwareStore } from '@/lib/storage';
import { publishRelease, readExistingReleases } from '@/lib/firmware-releases';
import { decidePublish, PublishRefused } from '@/lib/firmware-publish-rules';
import {
  firmwareManifest, refuseReleaseImage, refuseRegistryArtifact, refuseInstallImage, refuseInstallImageMismatch,
} from '@/lib/firmware-manifest';
import { isAllowed, parseAllowlist } from '@/lib/superadmin-allowlist';
import { semverOf } from '@/lib/firmware-version';
import { firmwareReleases } from '@/db/schema/firmware';
import {
  githubReleasePlan, assertSameBytes, checkInstallUf2, INSTALL_UF2_BUILD_NAME, type GithubReleaseInput,
} from '@/lib/firmware-github-release';
import { signingKeyId, PRIVATE_KEY_PATH } from './firmware-signing-key';

const repoRoot = process.cwd();
const headerPath = join(repoRoot, 'wifi-floppy/firmware/build/generated/wifi_floppy_version.h');
const buildDir = join(repoRoot, 'wifi-floppy/firmware/build');
const binPath = join(buildDir, 'wifi_floppy.bin');
// The first-install image (non-TBYB) and the UF2 that carries it: GitHub only.
const installBinPath = join(buildDir, 'wifi_floppy_install.bin');
const installUf2Path = join(buildDir, INSTALL_UF2_BUILD_NAME);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// parseArgs rather than scanning argv by hand: it rejects an unknown flag
// (a typo in --dry-run would otherwise do a REAL publish) and rejects
// `--notes` with no value instead of silently swallowing the next flag as
// the note text.
let args;
try {
  ({ values: args } = parseArgs({
    options: {
      notes: { type: 'string' },
      security: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-github': { type: 'boolean', default: false },
      'github-only': { type: 'boolean', default: false },
    },
    strict: true,
  }));
} catch (e) {
  die(`${(e as Error).message}\n\nUsage: pnpm firmware:publish [--notes "..."] [--security] [--dry-run] [--no-github] [--github-only]`);
}
const dryRun = args['dry-run'] ?? false;
const notes = args.notes ?? null;
const security = args.security ?? false;
const noGithub = args['no-github'] ?? false;
const githubOnly = args['github-only'] ?? false;

// 1. Read the version from the image's own header.
//
// The git work tree is NOT checked here. The generator already bakes -dirty
// into the version when the FIRMWARE sources are dirty, and decidePublish
// refuses that string -- whereas a repo-wide `git status` would refuse a
// perfectly clean, correctly-versioned image because an unrelated web-app file
// had moved.
if (!existsSync(headerPath)) {
  die(`No generated header at ${headerPath}.\nRun pnpm firmware:build first.`);
}
const m = /#define WF_FIRMWARE_VERSION "([^"]+)"/.exec(readFileSync(headerPath, 'utf8'));
if (!m) die(`Could not read WF_FIRMWARE_VERSION from ${headerPath}.`);
const version = m[1];
const semver = semverOf(version);
if (!semver) die(`Cannot read a semver out of ${version}.`);

// 2. The artifact must be the image this header describes.
//
// The version header is regenerated BEFORE compilation (it is an ALL target
// the executable depends on), so a build that fails after that point leaves a
// NEW header beside the PREVIOUS successful .bin. Publishing then records the
// new version against the old image's digest -- a version that does not match
// its image, which is the whole class of lie this increment removes. The
// version string is embedded in the image, so the check is exact rather than
// a timestamp heuristic.
if (!existsSync(binPath)) die(`No artifact at ${binPath}.\nRun pnpm firmware:build first.`);
const bytes = readFileSync(binPath);
if (!bytes.includes(Buffer.from(version, 'ascii'))) {
  die(
    `${binPath} does not contain the version ${version} from the generated header.\n`
    + `The header is regenerated before compilation, so this usually means the last\n`
    + `build FAILED and left the previous image in place. Re-run pnpm firmware:build\n`
    + `and check it succeeds.`,
  );
}

// picotool reads the image itself for the safety properties a build cannot
// otherwise be trusted to have (spec D10): TBYB (so a bad update reverts
// rather than bricking the board), a hash for the boot ROM to check, and no
// debug-only firmware command compiled in.
let info: string;
try {
  info = execFileSync('picotool', ['info', '-a', binPath, '-t', 'bin'], { encoding: 'utf8' });
} catch (e) {
  die(`picotool not found or failed: ${(e as Error).message} — install picotool 2.x (brew install picotool)`);
}
const refusal = refuseReleaseImage(info, bytes.byteLength, bytes, notes);
if (refusal) die(`Publish refused: ${refusal}`);

if (statSync(binPath).mtimeMs < statSync(headerPath).mtimeMs) {
  die(`${binPath} is older than the generated header. Re-run pnpm firmware:build.`);
}
const sha256 = createHash('sha256').update(bytes).digest('hex');

// The registry (and so every board's OTA) only ever takes wifi_floppy.bin --
// never wifi_floppy_install.bin, which has no TBYB. refuseReleaseImage above
// already refuses a non-TBYB image; this guards the path itself too.
const registryRefusal = refuseRegistryArtifact(binPath);
if (registryRefusal) die(`Publish refused: ${registryRefusal}`);

// Checked up front (unless GitHub is skipped), so a missing or stale install
// UF2 stops the run before anything is signed or recorded.
if (!noGithub) {
  const installRefusal = installArtifactsRefusal(version);
  if (installRefusal) die(`Publish refused: ${installRefusal}\nRun pnpm firmware:build, or pass --no-github.`);
}

// --github-only: attach an ALREADY-published version's files to its GitHub
// release. Nothing is signed or recorded; the registry row supplies the
// signature, and the built .bin must be byte-identical to the published one.
if (githubOnly) {
  const [row] = await getDb().select().from(firmwareReleases).where(eq(firmwareReleases.version, version)).limit(1);
  if (!row) die(`${version} is not in the registry; publish it first.`);
  try { assertSameBytes(row.sha256, sha256); } catch (e) { die((e as Error).message); }
  publishToGithub({
    version, semver, sequence: row.sequence, sha256, signature: row.signature,
    signingKeyId: row.signingKeyId, notes: row.notes,
  });
  process.exit(0);
}

// 3. Load the signing key. An absent key stops the publish here -- before
//    anything else runs -- and it never falls back to publishing unsigned,
//    because a registry with a mix of signed and unsigned rows cannot be
//    checked by increment 2 at all. The manifest itself is signed later, once
//    `sequence` is known (spec D4: the signature covers the sequence).
if (!existsSync(PRIVATE_KEY_PATH)) {
  die(`No signing key at ${PRIVATE_KEY_PATH}.\nRun pnpm firmware:keygen first.`);
}
const key = createPrivateKey(readFileSync(PRIVATE_KEY_PATH));
const keyId = signingKeyId(createPublicKey(key));

const blobPath = `firmware/${version}.bin`;

console.log(`version   ${version}`);
console.log(`semver    ${semver}`);
console.log(`sha256    ${sha256}`);
console.log(`size      ${bytes.byteLength} bytes`);
console.log(`blob      ${blobPath}`);
console.log(`notes     ${notes ?? '(none)'}`);
if (security) console.log('security  YES');

// 4. Decide BEFORE uploading anything.
//
// The upload used to come first, which meant every refusal left an orphaned
// blob at a path `allowOverwrite: false` would not let a retry re-use -- so a
// fixable refusal permanently wedged that version, which is derived from the
// commit hash and cannot be chosen. Deciding first also makes --dry-run able
// to report the refusal the real publish would hit, which is the entire point
// of a dry run.
const existing = await readExistingReleases();
let sequence: number;
try {
  sequence = decidePublish(existing, { version, semver });
} catch (e) {
  if (e instanceof PublishRefused) die(`\nPublish refused: ${e.detail ?? e.reason}`);
  throw e;
}
console.log(`sequence  ${sequence}`);

// The manifest, not the bare digest, is what the board verifies (spec D4):
// binding the sequence into the signed bytes is what makes the board's own
// anti-rollback check (readFirmwareInstruction's `sequence`) trustworthy even
// if the server were compromised.
const manifest = firmwareManifest({ version, sequence, sha256, sizeBytes: bytes.byteLength });
const signature = edSign(null, Buffer.from(manifest, 'ascii'), key).toString('base64');
console.log(`signature ${signature.slice(0, 16)}... (${keyId})`);

if (dryRun) {
  console.log('\n--dry-run: nothing uploaded, nothing recorded.');
  process.exit(0);
}

// 5. Whose publish this is. Recorded so the admin list can say who shipped a
//    release. There is no session here, so it comes from the allowlist -- and
//    is looked up lowercased, because isAllowed() compares lowercased while
//    better-auth stores the address as the user typed it.
const admins = parseAllowlist(process.env.SUPERADMIN_EMAILS);
if (admins.length === 0) die('SUPERADMIN_EMAILS is not set; refusing to publish anonymously.');
const email = process.env.WEBADF_PUBLISHER?.trim().toLowerCase() ?? admins[0];
if (!isAllowed(email, process.env.SUPERADMIN_EMAILS)) {
  die(`${email} is not in SUPERADMIN_EMAILS.`);
}
if (admins.length > 1 && !process.env.WEBADF_PUBLISHER) {
  console.warn(
    `\nNote: SUPERADMIN_EMAILS lists ${admins.length} addresses; attributing this release to`
    + ` ${email}.\nSet WEBADF_PUBLISHER to record a different one.`,
  );
}
const rows = await getDb().select({ id: user.id }).from(user).where(eq(user.email, email));
if (rows.length === 0) die(`No user row for ${email}; sign in once before publishing.`);
const userId = rows[0].id;

// 6. Upload, then record. This order matters for the crash case: an orphaned
//    blob is recoverable, whereas a registry row pointing at nothing is an
//    image increment 2 would try to flash. A blob already present is reused
//    ONLY when its content matches this build's digest -- it is then
//    genuinely content this script uploaded on an earlier attempt, and
//    refusing forever would strand the version. Without the digest check, a
//    blob left behind by an earlier attempt (the sequence-moved refusal below
//    fires AFTER this upload, so a retry is the expected path) would be
//    reused unchecked while a REBUILD in between -- which embeds a new build
//    date -- changed the bytes: the manifest signed above covers the new
//    bytes, but the object a board would download is the old ones. A release
//    no board could ever verify.
const already = await head(blobPath).catch(() => null);
if (!already) {
  await put(blobPath, bytes, {
    access: 'private',
    contentType: 'application/octet-stream',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
} else {
  // Read through the same store the download route serves from, rather than
  // trusting `head`'s size/etag -- the content itself is what has to match.
  const existingBytes = await firmwareStore.read(blobPath);
  if (!existingBytes) {
    die(`${blobPath} is present in the blob store but could not be read. Delete it and re-run.`);
  }
  const existingSha256 = createHash('sha256').update(existingBytes).digest('hex');
  if (existingSha256 !== sha256) {
    die(
      `${blobPath} already exists in the blob store but its content does not match this build\n`
      + `(stored sha256 ${existingSha256}, built sha256 ${sha256}). It is very likely left over\n`
      + `from an earlier, differently-built attempt. Delete ${blobPath} from the blob store and re-run.`,
    );
  }
  console.log('blob already present from an earlier attempt, with matching content; reusing it.');
}

try {
  const published = await publishRelease(
    {
      version, semver, sha256, sizeBytes: bytes.byteLength, blobPath, signature, signingKeyId: keyId, notes,
      security, signatureFormat: 2,
    },
    userId,
    sequence,
  );
  console.log(`\nPublished ${version} as sequence ${published.sequence}.`);
  if (noGithub) console.log('GitHub release skipped (--no-github).');
  else {
    // The registry is the source of truth; a GitHub failure is reported, not
    // fatal -- `pnpm firmware:publish --github-only` repairs it afterwards.
    try {
      publishToGithub({ version, semver, sequence: published.sequence, sha256, signature, signingKeyId: keyId, notes });
    } catch (e) {
      console.error(`GitHub release NOT published: ${(e as Error).message}\nRepair with: pnpm firmware:publish --github-only`);
    }
  }
} catch (e) {
  if (e instanceof PublishRefused) die(`\nPublish refused: ${e.detail ?? e.reason}`);
  throw e;
}

// GitHub: the same signed wifi_floppy.bin the web app serves, plus the USB files (src/lib/firmware-github-release.ts).
function publishToGithub(r: GithubReleaseInput): void {
  const plan = githubReleasePlan(r);
  if (!plan.publish) { console.log(`GitHub release skipped: ${plan.reason}`); return; }
  const files = ['wifi_floppy.bin', 'wifi_floppy.uf2', 'wifi_floppy_pt.uf2'].map((f) => join(buildDir, f));
  for (const f of files) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const installRefusal = installArtifactsRefusal(r.version);
  if (installRefusal) throw new Error(installRefusal);
  const tmp = mkdtempSync(join(tmpdir(), 'wf-gh-'));
  const manifestPath = join(tmp, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');
  // The single drag-and-drop first-install file, named by semver.
  const installAsset = join(tmp, plan.installAsset);
  writeFileSync(installAsset, readFileSync(installUf2Path));
  const assets = [...files, installAsset, manifestPath];
  // The release points at the build's own commit (the g<hash> in the version).
  const short = /\+g([0-9a-f]+)$/.exec(r.version)?.[1];
  const commit = short ? execFileSync('git', ['rev-parse', short], { encoding: 'utf8' }).trim() : 'master';
  const gh = (a: string[]) => execFileSync('gh', a, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  let exists = true;
  try { gh(['release', 'view', plan.tag]); } catch { exists = false; }
  if (exists) {
    gh(['release', 'edit', plan.tag, '--title', plan.title, '--notes', plan.body]);
    gh(['release', 'upload', plan.tag, ...assets, '--clobber']);
  } else {
    gh(['release', 'create', plan.tag, ...assets, '--target', commit, '--title', plan.title, '--notes', plan.body]);
  }
  console.log(`GitHub release ${plan.tag} ${exists ? 'updated' : 'created'} with the published files.`);
}

// The first-install UF2 must carry THIS version's non-TBYB image, all in the
// absolute family and clear of the settings sectors. null when it does.
function installArtifactsRefusal(v: string): string | null {
  if (!existsSync(installBinPath)) return `missing ${installBinPath}`;
  if (!existsSync(installUf2Path)) return `missing ${installUf2Path}`;
  const installBin = readFileSync(installBinPath);
  if (!installBin.includes(Buffer.from(v, 'ascii'))) return `${installBinPath} is not version ${v}`;
  let installInfo: string;
  try {
    installInfo = execFileSync('picotool', ['info', '-a', installBinPath, '-t', 'bin'], { encoding: 'utf8' });
  } catch (e) {
    return `picotool failed on ${installBinPath}: ${(e as Error).message}`;
  }
  const imageRefusal = refuseInstallImage(installInfo);
  if (imageRefusal) return imageRefusal;
  // Review I1: byte for byte the release image, except the TBYB flag and the
  // hash -- so a stale, debug or DF1-default install image cannot slip through.
  const mismatch = refuseInstallImageMismatch(readFileSync(binPath), installBin);
  if (mismatch) return mismatch;
  const uf2Refusal = checkInstallUf2(readFileSync(installUf2Path), v);
  if (uf2Refusal) return `${installUf2Path}: ${uf2Refusal}`;
  if (statSync(installUf2Path).mtimeMs < statSync(installBinPath).mtimeMs) {
    return `${installUf2Path} is older than ${installBinPath}; re-run pnpm firmware:build`;
  }
  return null;
}
