import type { SelfhostConfig } from './config';
import type { SecretName } from './secrets';

/** Self-hosting P2: the environment the app and scheduler run with, from .env's settings and data/secrets. */
export function applyAppEnv(env: Record<string, string | undefined>, cfg: SelfhostConfig, s: Record<SecretName, string>): void {
  env.DATABASE_URL = `postgresql://webadf:${encodeURIComponent(s.pg_password)}@db:5432/webadf`;
  env.BETTER_AUTH_SECRET = s.better_auth_secret;
  env.CRON_SECRET = s.cron_secret;
  // The resolved address, also in domain mode (WEBADF_URL empty, WEBADF_DOMAIN set): origin-warn.ts reads both.
  env.WEBADF_URL = cfg.url;
  env.BETTER_AUTH_URL = cfg.url;
  env.SUPERADMIN_EMAILS = cfg.superadmins;
  env.STORAGE_DIR = '/data/blobs';
  delete env.BLOB_READ_WRITE_TOKEN;
  // The weekly blob GC deletes, as on our deployment (parity); BLOB_GC_DELETE=0 in .env makes it report only.
  if (!env.BLOB_GC_DELETE?.trim()) env.BLOB_GC_DELETE = '1'; // unset or empty = the default
}
