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
 * Usage:  pnpm firmware:publish [--notes "..."] [--security] [--dry-run]
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { put, head } from '@vercel/blob';
import { getDb } from '@/db';
import { user } from '@/db/schema/auth';
import { publishRelease, readExistingReleases } from '@/lib/firmware-releases';
import { decidePublish, PublishRefused } from '@/lib/firmware-publish-rules';
import { isAllowed, parseAllowlist } from '@/lib/superadmin-allowlist';
import { semverOf } from '@/lib/firmware-version';
import { signingKeyId, PRIVATE_KEY_PATH } from './firmware-signing-key';

const repoRoot = process.cwd();
const headerPath = join(repoRoot, 'wifi-floppy/firmware/build/generated/wifi_floppy_version.h');
const uf2Path = join(repoRoot, 'wifi-floppy/firmware/build/wifi_floppy.uf2');

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
    },
    strict: true,
  }));
} catch (e) {
  die(`${(e as Error).message}\n\nUsage: pnpm firmware:publish [--notes "..."] [--security] [--dry-run]`);
}
const dryRun = args['dry-run'] ?? false;
const notes = args.notes ?? null;
const security = args.security ?? false;

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
// NEW header beside the PREVIOUS successful .uf2. Publishing then records the
// new version against the old image's digest -- a version that does not match
// its image, which is the whole class of lie this increment removes. The
// version string is embedded in the image, so the check is exact rather than
// a timestamp heuristic.
if (!existsSync(uf2Path)) die(`No artifact at ${uf2Path}.\nRun pnpm firmware:build first.`);
const bytes = readFileSync(uf2Path);
if (!bytes.includes(Buffer.from(version, 'ascii'))) {
  die(
    `${uf2Path} does not contain the version ${version} from the generated header.\n`
    + `The header is regenerated before compilation, so this usually means the last\n`
    + `build FAILED and left the previous image in place. Re-run pnpm firmware:build\n`
    + `and check it succeeds.`,
  );
}
if (statSync(uf2Path).mtimeMs < statSync(headerPath).mtimeMs) {
  die(`${uf2Path} is older than the generated header. Re-run pnpm firmware:build.`);
}
const sha256 = createHash('sha256').update(bytes).digest('hex');

// 3. Sign the digest offline. An absent key stops the publish -- it never
//    falls back to publishing unsigned, because a registry with a mix of
//    signed and unsigned rows cannot be checked by increment 2 at all.
if (!existsSync(PRIVATE_KEY_PATH)) {
  die(`No signing key at ${PRIVATE_KEY_PATH}.\nRun pnpm firmware:keygen first.`);
}
const key = createPrivateKey(readFileSync(PRIVATE_KEY_PATH));
const signature = edSign(null, Buffer.from(sha256, 'hex'), key).toString('base64');
const keyId = signingKeyId(createPublicKey(key));

const blobPath = `firmware/${version}.uf2`;

console.log(`version   ${version}`);
console.log(`semver    ${semver}`);
console.log(`sha256    ${sha256}`);
console.log(`size      ${bytes.byteLength} bytes`);
console.log(`signature ${signature.slice(0, 16)}... (${keyId})`);
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
  if (e instanceof PublishRefused) die(`\nPublish refused: ${e.reason}`);
  throw e;
}
console.log(`sequence  ${sequence}`);

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
//    image increment 2 would try to flash. A blob already present with the
//    same digest is treated as success -- it is content this script uploaded
//    on an earlier attempt, and refusing forever would strand the version.
const already = await head(blobPath).catch(() => null);
if (!already) {
  await put(blobPath, bytes, {
    access: 'private',
    contentType: 'application/octet-stream',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
} else {
  console.log('blob already present from an earlier attempt; reusing it.');
}

try {
  const published = await publishRelease(
    { version, semver, sha256, sizeBytes: bytes.byteLength, blobPath, signature, signingKeyId: keyId, notes, security },
    userId,
  );
  console.log(`\nPublished ${version} as sequence ${published.sequence}.`);
} catch (e) {
  if (e instanceof PublishRefused) die(`\nPublish refused: ${e.reason}`);
  throw e;
}
