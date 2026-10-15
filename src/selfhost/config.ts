/** Self-hosting P2 (spec D3): the two required settings, validated, with the fix in every message. */
export interface SelfhostConfig {
  url: string; host: string; domain: string | null; adminEmail: string; superadmins: string; httpsPort: number;
}
export class ConfigError extends Error {}

export function resolveConfig(env: Record<string, string | undefined>): SelfhostConfig {
  const portRaw = env.WEBADF_HTTPS_PORT?.trim() || '443';
  if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
    throw new ConfigError(`WEBADF_HTTPS_PORT must be a port number (1-65535), got "${portRaw}"`);
  }
  const httpsPort = Number(portRaw);
  const rawDomain = env.WEBADF_DOMAIN?.trim() ?? '';
  const domain = rawDomain ? rawDomain.toLowerCase().replace(/\.$/, '') : null;
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new ConfigError(`WEBADF_DOMAIN must be a bare DNS name like amiga.example.org (no https://, port or path), got "${rawDomain}"`);
  }
  const rawUrl = env.WEBADF_URL?.trim() || (domain ? `https://${domain}` : '');
  if (!rawUrl) throw new ConfigError('Set WEBADF_URL in .env to the address you open webadf at, e.g. https://192.168.1.10 (or set WEBADF_DOMAIN to a public DNS name)');
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new ConfigError(`WEBADF_URL is not a valid address: "${rawUrl}" -- e.g. https://192.168.1.10`); }
  if (u.protocol !== 'https:') throw new ConfigError(`WEBADF_URL must start with https:// (Caddy serves TLS), got "${rawUrl}"`);
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new ConfigError(`WEBADF_URL must be just the address, without a path: use "${u.origin}"`);
  }
  if (domain) {
    if (u.origin !== `https://${domain}`) throw new ConfigError(`WEBADF_URL and WEBADF_DOMAIN disagree ("${u.origin}" vs "https://${domain}") -- set only WEBADF_DOMAIN`);
    if (httpsPort !== 443) throw new ConfigError('WEBADF_DOMAIN needs WEBADF_HTTPS_PORT=443: Let\'s Encrypt checks the domain on port 443');
  }
  const urlPort = Number(u.port || 443);
  if (urlPort !== httpsPort) {
    throw new ConfigError(`WEBADF_URL says port ${urlPort} but WEBADF_HTTPS_PORT is ${httpsPort} -- make them the same (the port people type is the port Caddy publishes)`);
  }
  const adminRaw = env.WEBADF_ADMIN_EMAIL?.trim();
  if (!adminRaw) throw new ConfigError('Set WEBADF_ADMIN_EMAIL in .env (it becomes the first admin)');
  if (!/^[^\s@]+@[^\s@]+$/.test(adminRaw)) throw new ConfigError(`WEBADF_ADMIN_EMAIL is not an email address: "${adminRaw}"`);
  const adminEmail = adminRaw.toLowerCase();
  return {
    url: u.origin, host: u.hostname, domain, adminEmail,
    superadmins: env.SUPERADMIN_EMAILS?.trim() || adminEmail, httpsPort,
  };
}
