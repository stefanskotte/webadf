import { describe, it, expect } from 'vitest';
import { resolveConfig, ConfigError } from './config';

const base = { WEBADF_ADMIN_EMAIL: 'Me@Example.org' };

describe('resolveConfig', () => {
  it('takes WEBADF_URL as the origin and derives host', () => {
    const c = resolveConfig({ ...base, WEBADF_URL: 'https://192.168.1.10/' });
    expect(c).toMatchObject({ url: 'https://192.168.1.10', host: '192.168.1.10', domain: null, adminEmail: 'me@example.org', superadmins: 'me@example.org', httpsPort: 443 });
  });
  it('keeps a non-default port in the url', () => {
    const c = resolveConfig({ ...base, WEBADF_URL: 'https://amiga.lan:8443', WEBADF_HTTPS_PORT: '8443' });
    expect(c.url).toBe('https://amiga.lan:8443');
    expect(c.httpsPort).toBe(8443);
  });
  it('derives the url from WEBADF_DOMAIN', () => {
    const c = resolveConfig({ ...base, WEBADF_DOMAIN: 'amiga.example.org' });
    expect(c).toMatchObject({ url: 'https://amiga.example.org', domain: 'amiga.example.org', host: 'amiga.example.org' });
  });
  it('accepts both when they agree', () => {
    expect(resolveConfig({ ...base, WEBADF_DOMAIN: 'a.example.org', WEBADF_URL: 'https://a.example.org' }).domain).toBe('a.example.org');
  });
  it('honours an explicit SUPERADMIN_EMAILS', () => {
    expect(resolveConfig({ ...base, WEBADF_URL: 'https://x.lan', SUPERADMIN_EMAILS: 'a@b.c,d@e.f' }).superadmins).toBe('a@b.c,d@e.f');
  });
  it.each([
    [{ ...base }, /Set WEBADF_URL in \.env to the address you open webadf at/],
    [{ ...base, WEBADF_URL: 'http://192.168.1.10' }, /WEBADF_URL must start with https:\/\//],
    [{ ...base, WEBADF_URL: 'https://x.lan/webadf' }, /WEBADF_URL must be just the address/],
    [{ ...base, WEBADF_URL: 'not a url' }, /WEBADF_URL is not a valid address/],
    [{ ...base, WEBADF_DOMAIN: 'a.example.org', WEBADF_URL: 'https://b.example.org' }, /WEBADF_URL and WEBADF_DOMAIN disagree/],
    [{ ...base, WEBADF_DOMAIN: 'a.example.org', WEBADF_HTTPS_PORT: '8443' }, /WEBADF_DOMAIN needs WEBADF_HTTPS_PORT=443/],
    [{ ...base, WEBADF_URL: 'https://x.lan', WEBADF_HTTPS_PORT: 'abc' }, /WEBADF_HTTPS_PORT must be a port number/],
    [{ WEBADF_URL: 'https://x.lan' }, /Set WEBADF_ADMIN_EMAIL in \.env/],
    [{ WEBADF_URL: 'https://x.lan', WEBADF_ADMIN_EMAIL: 'nope' }, /WEBADF_ADMIN_EMAIL is not an email address/],
  ])('refuses %j', (env, msg) => {
    expect(() => resolveConfig(env)).toThrow(ConfigError);
    expect(() => resolveConfig(env)).toThrow(msg);
  });
});
