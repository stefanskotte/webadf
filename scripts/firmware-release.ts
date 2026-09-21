/**
 * Builds nothing, signs and publishes what is already built (spec §3.4).
 *
 * The version is read out of the GENERATED HEADER, never from an argument, so
 * the published version is by construction the one inside the image. Passing
 * it in would reintroduce exactly the drift this increment removed.
 *
 * It writes to the registry through publishRelease() rather than through
 * POST /api/admin/firmware/releases, because an admin route is guarded by a
 * session cookie and there is no honest way to hand a CLI one. This script
 * already needs DATABASE_URL and BLOB_READ_WRITE_TOKEN -- strictly more
 * authority than the route grants -- so routing through HTTP would add a
 * hop and an auth problem without adding a control.
 *
 * Usage:  pnpm firmware:publish [--notes "..."] [--security] [--dry-run]
 */
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { getDb } from '@/db';
import { user } from '@/db/schema/auth';
import { publishRelease, PublishRefused } from '@/lib/firmware-releases';
import { isSuperAdminEmail } from '@/lib/superadmin';

const repoRoot = process.cwd();
const headerPath = join(repoRoot, 'wifi-floppy/firmware/build/generated/wifi_floppy_version.h');
const uf2Path = join(repoRoot, 'wifi-floppy/firmware/build/wifi_floppy.uf2');
const keyPath = join(homedir(), '.webadf', 'firmware-signing-key');

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const notesIdx = args.indexOf('--notes');
const notes = notesIdx >= 0 ? (args[notesIdx + 1] ?? null) : null;
const security = args.includes('--security');

// 1. Refuse a dirty tree. A build nobody can identify must not become the
//    thing a fleet is compared against. (The generated version would carry
//    -dirty anyway and be refused downstream; failing here says why.)
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString().trim();
if (dirty) die(`Refusing to publish: the git work tree is dirty.\n${dirty}`);

// 2. Read the version from the image's own header.
if (!existsSync(headerPath)) {
  die(`No generated header at ${headerPath}.\nRun pnpm firmware:build first.`);
}
const m = /#define WF_FIRMWARE_VERSION "([^"]+)"/.exec(readFileSync(headerPath, 'utf8'));
if (!m) die(`Could not read WF_FIRMWARE_VERSION from ${headerPath}.`);
const version = m[1];
if (version.endsWith('-dirty')) die(`Refusing to publish a dirty build: ${version}`);
const semver = version.split('+')[0];

// 3. Hash the artifact.
if (!existsSync(uf2Path)) die(`No artifact at ${uf2Path}.\nRun pnpm firmware:build first.`);
const bytes = readFileSync(uf2Path);
const sha256 = createHash('sha256').update(bytes).digest('hex');

// 4. Sign the digest offline. An absent key stops the publish -- it never
//    falls back to publishing unsigned, because a registry with a mix of
//    signed and unsigned rows cannot be checked by increment 2 at all.
if (!existsSync(keyPath)) die(`No signing key at ${keyPath}.\nRun pnpm firmware:keygen first.`);
const key = createPrivateKey(readFileSync(keyPath));
const signature = edSign(null, Buffer.from(sha256, 'hex'), key).toString('base64');
const signingKeyId = process.env.WF_SIGNING_KEY_ID ?? `wf-release-${new Date().getFullYear()}`;

const blobPath = `firmware/${version}.uf2`;

console.log(`version   ${version}`);
console.log(`semver    ${semver}`);
console.log(`sha256    ${sha256}`);
console.log(`size      ${bytes.byteLength} bytes`);
console.log(`signature ${signature.slice(0, 16)}... (${signingKeyId})`);
console.log(`blob      ${blobPath}`);
console.log(`notes     ${notes ?? '(none)'}${security ? '\nsecurity  YES' : ''}`);

if (dryRun) {
  console.log('\n--dry-run: nothing uploaded, nothing recorded.');
  process.exit(0);
}

// 5. Whose publish this is. Recorded rather than left blank so the admin list
//    can say who shipped a release.
const admins = (process.env.SUPERADMIN_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean);
if (admins.length === 0) die('SUPERADMIN_EMAILS is not set; refusing to publish anonymously.');
const email = admins[0];
if (!isSuperAdminEmail(email)) die(`${email} is not a super-admin.`);
const rows = await getDb().select({ id: user.id }).from(user).where(eq(user.email, email));
if (rows.length === 0) die(`No user row for ${email}; sign in once before publishing.`);
const userId = rows[0].id;

// 6. Upload, then record. This order matters: a crash between them leaves an
//    orphaned blob, which is harmless, whereas the reverse leaves a registry
//    row pointing at nothing -- and increment 2 would try to flash it.
await put(blobPath, bytes, {
  access: 'private',
  contentType: 'application/octet-stream',
  addRandomSuffix: false,
  allowOverwrite: false,
});

try {
  const { sequence } = await publishRelease(
    { version, semver, sha256, sizeBytes: bytes.byteLength, blobPath, signature, signingKeyId, notes, security },
    userId,
  );
  console.log(`\nPublished ${version} as sequence ${sequence}.`);
} catch (e) {
  if (e instanceof PublishRefused) die(`\nPublish refused: ${e.reason}`);
  throw e;
}
