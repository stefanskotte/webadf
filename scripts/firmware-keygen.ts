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
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { signingKeyId, KEYS_DIR, PRIVATE_KEY_PATH } from './firmware-signing-key';

if (existsSync(PRIVATE_KEY_PATH)) {
  console.error(`Refusing to overwrite an existing key at ${PRIVATE_KEY_PATH}.`);
  console.error('Generating a new one would orphan every release signed with the old one.');
  console.error('\nIf you only need the PUBLIC half back (e.g. the terminal scrolled),');
  console.error(`run:  openssl pkey -in ${PRIVATE_KEY_PATH} -pubout`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(join(homedir(), '.webadf'), { recursive: true, mode: 0o700 });
writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  mode: 0o600,
});
// writeFileSync's mode is masked by the process umask, so it is not enough on
// its own -- a umask of 022 would still leave this group- and world-readable.
chmodSync(PRIVATE_KEY_PATH, 0o600);

// Derived from the key material, never from the calendar. A key id computed
// from `new Date().getFullYear()` at keygen and again at publish agrees only
// while both happen in the same year: the first publish after New Year would
// record an id naming a public key file that does not exist, and increment 2
// looks the key up by exactly that id.
const keyId = signingKeyId(createPublicKey(privateKey));

// Written here rather than printed for the operator to copy. Losing the
// terminal output used to mean the public half was unrecoverable through this
// tool, because the refuse-to-overwrite guard then blocks every re-run.
mkdirSync(KEYS_DIR, { recursive: true });
const pubPath = join(KEYS_DIR, `${keyId}.pem`);
writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));

console.log(`Private key: ${PRIVATE_KEY_PATH} (mode 0600). Back it up somewhere offline.`);
console.log(`Public key:  ${pubPath}`);
console.log(`Key id:      ${keyId}  (a fingerprint of the key itself)`);
console.log('\nCommit the public key. The private half must never enter the repo.');
