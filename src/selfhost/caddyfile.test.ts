import { describe, it, expect } from 'vitest';
import { renderCaddyfile } from './caddyfile';
import { resolveConfig } from './config';

const admin = { WEBADF_ADMIN_EMAIL: 'a@b.c' };

describe('renderCaddyfile', () => {
  it('uses internal TLS for the host of WEBADF_URL, on the container port 443', () => {
    const f = renderCaddyfile(resolveConfig({ ...admin, WEBADF_URL: 'https://192.168.1.10:8443', WEBADF_HTTPS_PORT: '8443' }));
    expect(f).toContain('https://192.168.1.10:443, https://:443 {');
    expect(f).toContain('tls internal');
    expect(f).toContain('reverse_proxy app:3000');
    expect(f).toContain('skip_install_trust');
  });
  it('sets default_sni to the host, so a client that sends no SNI (an IP address) still gets the certificate', () => {
    const f = renderCaddyfile(resolveConfig({ ...admin, WEBADF_URL: 'https://192.168.1.10' }));
    expect(f).toMatch(/^\{\n[^}]*\tdefault_sni 192\.168\.1\.10\n[^}]*\}/);
    const named = renderCaddyfile(resolveConfig({ ...admin, WEBADF_URL: 'https://amiga.lan' }));
    expect(named).toContain('\tdefault_sni amiga.lan\n');
  });
  it('serves every host on :443 in internal-TLS mode: a catch-all site, and the WEBADF_URL certificate for any other SNI name', () => {
    const f = renderCaddyfile(resolveConfig({ ...admin, WEBADF_URL: 'https://localhost:8444', WEBADF_HTTPS_PORT: '8444' }));
    expect(f).toContain('https://localhost:443, https://:443 {');
    expect(f).toContain('\tfallback_sni localhost\n');
    // No certificate is minted per requested name (on-demand TLS would let any client fill data/caddy).
    expect(f).not.toContain('on_demand');
  });
  it('IPv6: the site address keeps the brackets, default_sni and fallback_sni are the bare address', () => {
    const f = renderCaddyfile(resolveConfig({ ...admin, WEBADF_URL: 'https://[fd00::10]' }));
    expect(f).toContain('https://[fd00::10]:443, https://:443 {');
    expect(f).toContain('\tdefault_sni fd00::10\n');
    expect(f).toContain('\tfallback_sni fd00::10\n');
  });
  it('uses automatic HTTPS for a domain and never internal TLS', () => {
    const f = renderCaddyfile(resolveConfig({ ...admin, WEBADF_DOMAIN: 'amiga.example.org' }));
    expect(f).toContain('amiga.example.org {');
    expect(f).not.toContain('tls internal');
    expect(f).not.toContain('default_sni');
    expect(f).not.toContain('fallback_sni');
    expect(f).not.toContain('https://:443'); // other names are refused: no public certificate for arbitrary names
    expect(f).toContain('reverse_proxy app:3000');
  });
});
