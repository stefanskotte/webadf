import { describe, it, expect } from 'vitest';
import { renderCaddyfile } from './caddyfile';
import { resolveConfig } from './config';

const admin = { WEBADF_ADMIN_EMAIL: 'a@b.c' };

describe('renderCaddyfile', () => {
  it('uses internal TLS for the host of WEBADF_URL, on the container port 443', () => {
    const f = renderCaddyfile(resolveConfig({ ...admin, WEBADF_URL: 'https://192.168.1.10:8443', WEBADF_HTTPS_PORT: '8443' }));
    expect(f).toContain('https://192.168.1.10:443 {');
    expect(f).toContain('tls internal');
    expect(f).toContain('reverse_proxy app:3000');
    expect(f).toContain('skip_install_trust');
  });
  it('uses automatic HTTPS for a domain and never internal TLS', () => {
    const f = renderCaddyfile(resolveConfig({ ...admin, WEBADF_DOMAIN: 'amiga.example.org' }));
    expect(f).toContain('amiga.example.org {');
    expect(f).not.toContain('tls internal');
    expect(f).toContain('reverse_proxy app:3000');
  });
});
