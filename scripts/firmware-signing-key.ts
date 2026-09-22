import { createHash, type KeyObject } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the offline firmware signing key lives, and how it is named.
 *
 * Shared by firmware-keygen.ts and firmware-release.ts so the two cannot
 * disagree. They used to compute the key id independently as
 * `wf-release-${new Date().getFullYear()}` -- the same expression evaluated at
 * two different times, which agrees only while keygen and publish happen in
 * the same calendar year. The first publish after New Year would have recorded
 * a signingKeyId naming a public key file that does not exist, and increment 2
 * resolves the verifying key by exactly that id.
 */

/** Never in the repository. The whole point of D3. */
export const PRIVATE_KEY_PATH = join(homedir(), '.webadf', 'firmware-signing-key');

/** Public keys only, committed, compiled into the firmware by increment 2. */
export const KEYS_DIR = join(process.cwd(), 'wifi-floppy', 'firmware', 'keys');

/**
 * A fingerprint of the key material itself, so the id cannot drift from the
 * key that made a signature. Same input, same id, whenever it is computed.
 */
export function signingKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `wf-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}
