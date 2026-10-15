import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chownSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Self-hosting P2 (spec D4): generated once, never typed, never regenerated. */
export const SECRET_NAMES = ['better_auth_secret', 'cron_secret', 'pg_password'] as const;
export type SecretName = typeof SECRET_NAMES[number];
export class SecretError extends Error {}

export function ensureSecrets(dir: string, owner?: { uid: number; gid: number }): SecretName[] {
  mkdirSync(dirname(dir), { recursive: true });
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  if (owner) chownSync(dir, owner.uid, owner.gid);
  const created: SecretName[] = [];
  for (const name of SECRET_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) continue;
    writeFileSync(p, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    if (owner) chownSync(p, owner.uid, owner.gid);
    created.push(name);
  }
  return created;
}

export function readSecrets(dir: string): Record<SecretName, string> {
  const out = {} as Record<SecretName, string>;
  for (const name of SECRET_NAMES) {
    const p = join(dir, name);
    if (!existsSync(p)) throw new SecretError(`secrets/${name} is missing -- run docker compose up -d (the setup service creates it)`);
    const v = readFileSync(p, 'utf8').trim();
    if (!v) throw new SecretError(`secrets/${name} is empty -- restore it from a backup of the data folder (a new one would sign everyone out and lock out the database)`);
    out[name] = v;
  }
  return out;
}
