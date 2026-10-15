import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSecrets, readSecrets, SECRET_NAMES, SecretError } from './secrets';

const fresh = () => join(mkdtempSync(join(tmpdir(), 's-')), 'secrets');

describe('secrets', () => {
  it('creates all three once, 0600, 43-char base64url', () => {
    const d = fresh();
    expect(ensureSecrets(d)).toEqual([...SECRET_NAMES]);
    for (const n of SECRET_NAMES) {
      expect(readFileSync(join(d, n), 'utf8')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(statSync(join(d, n)).mode & 0o777).toBe(0o600);
    }
  });
  it('never touches an existing secret', () => {
    const d = fresh();
    ensureSecrets(d);
    const before = readFileSync(join(d, 'cron_secret'), 'utf8');
    expect(ensureSecrets(d)).toEqual([]);
    expect(readFileSync(join(d, 'cron_secret'), 'utf8')).toBe(before);
  });
  it('reads them back trimmed', () => {
    const d = fresh();
    ensureSecrets(d);
    writeFileSync(join(d, 'pg_password'), 'abc\n');
    expect(readSecrets(d).pg_password).toBe('abc');
  });
  it('refuses an emptied secret and does not regenerate it', () => {
    const d = fresh();
    ensureSecrets(d);
    writeFileSync(join(d, 'better_auth_secret'), '');
    expect(() => readSecrets(d)).toThrow(SecretError);
    expect(() => readSecrets(d)).toThrow(/secrets\/better_auth_secret is empty -- restore it from a backup of the data folder/);
    expect(ensureSecrets(d)).toEqual([]);
  });
  it('names a missing secret', () => {
    expect(() => readSecrets(fresh())).toThrow(/secrets\/better_auth_secret is missing -- run docker compose up -d/);
  });
});

describe('secrets parent directories (fix round 1, I3)', () => {
  it('creates missing parents with the default mode, and the secrets folder itself at 0700', () => {
    const base = mkdtempSync(join(tmpdir(), 'p-'));
    ensureSecrets(join(base, 'data', 'secrets'));
    expect(statSync(join(base, 'data')).mode & 0o777).not.toBe(0o700);
    expect(statSync(join(base, 'data', 'secrets')).mode & 0o777).toBe(0o700);
  });
});
