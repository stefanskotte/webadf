/**
 * Generates the offline firmware signing keypair (spec D3).
 *
 * The private key never leaves this machine and is never read by server code.
 * That is the single control that matters: TLS protects the wire and the
 * device already pins roots, but neither does anything about a compromised
 * Vercel account or a poisoned deploy pipeline. With the key offline, whoever
 * owns the pipeline can push a STALE image and nothing worse -- and
 * anti-rollback (increment 2) closes that too.
 *
 * Run once: pnpm firmware:keygen
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.webadf');
const keyPath = join(dir, 'firmware-signing-key');

if (existsSync(keyPath)) {
  console.error(`Refusing to overwrite an existing key at ${keyPath}.`);
  console.error('Generating a new one would orphan every release signed with the old one.');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
// writeFileSync's mode is masked by the process umask, so it is not enough on
// its own -- a umask of 022 would still leave this group- and world-readable.
chmodSync(keyPath, 0o600);

const keyId = `wf-release-${new Date().getFullYear()}`;
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();

console.log(`Private key written to ${keyPath} (mode 0600). Back it up somewhere offline.`);
console.log(`\nKey id: ${keyId}`);
console.log(`\nCommit this public key to wifi-floppy/firmware/keys/${keyId}.pem:\n`);
console.log(pub);
