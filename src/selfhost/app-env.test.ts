import { describe, it, expect } from 'vitest';
import { applyAppEnv } from './app-env';
import { resolveConfig } from './config';

const secrets = { better_auth_secret: 'b', cron_secret: 'c', pg_password: 'p w' };

describe('applyAppEnv', () => {
  it('sets WEBADF_URL from the resolved config, so the origin warner is active in domain mode too (WEBADF_URL empty in .env)', () => {
    const env: Record<string, string | undefined> = { WEBADF_URL: '', WEBADF_DOMAIN: 'amiga.example.org', WEBADF_ADMIN_EMAIL: 'a@b.c' };
    applyAppEnv(env, resolveConfig(env), secrets);
    expect(env.WEBADF_URL).toBe('https://amiga.example.org');
    expect(env.BETTER_AUTH_URL).toBe('https://amiga.example.org');
  });
  it('wires the database, secrets and storage, drops the Vercel blob token, and defaults BLOB_GC_DELETE to 1', () => {
    const env: Record<string, string | undefined> = { WEBADF_URL: 'https://192.168.1.10', WEBADF_ADMIN_EMAIL: 'A@b.c', BLOB_READ_WRITE_TOKEN: 'x', BLOB_GC_DELETE: ' ' };
    applyAppEnv(env, resolveConfig(env), secrets);
    expect(env.DATABASE_URL).toBe('postgresql://webadf:p%20w@db:5432/webadf');
    expect(env.BETTER_AUTH_SECRET).toBe('b');
    expect(env.CRON_SECRET).toBe('c');
    expect(env.SUPERADMIN_EMAILS).toBe('a@b.c');
    expect(env.STORAGE_DIR).toBe('/data/blobs');
    expect('BLOB_READ_WRITE_TOKEN' in env).toBe(false);
    expect(env.BLOB_GC_DELETE).toBe('1');
    const keep: Record<string, string | undefined> = { WEBADF_URL: 'https://192.168.1.10', WEBADF_ADMIN_EMAIL: 'a@b.c', BLOB_GC_DELETE: '0' };
    applyAppEnv(keep, resolveConfig(keep), secrets);
    expect(keep.BLOB_GC_DELETE).toBe('0');
  });
});
