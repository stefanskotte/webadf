import type { SelfhostConfig } from './config';

/** Self-hosting P2 (spec D6): one site on the container's port 443. */
export function renderCaddyfile(c: SelfhostConfig): string {
  if (c.domain) {
    // Only the domain is served: Caddy refuses other names, and never asks Let's Encrypt for one it was not given.
    return `${c.domain} {\n\treverse_proxy app:3000\n}\n`;
  }
  // URL hostnames keep IPv6 brackets; a site address wants them, a TLS server name must not have them.
  const sni = c.host.replace(/^\[(.*)\]$/, '$1');
  return [
    '{',
    '\tskip_install_trust',
    // A client opening an IP address sends no SNI; without this Caddy would look up a certificate for the
    // connection's local address (the container's own IP behind Docker's port mapping) and find none.
    `\tdefault_sni ${sni}`,
    // A client asking for any other name (another DNS name or IP of this host) gets the same certificate,
    // instead of a failed handshake. No certificate is minted per name (on-demand TLS would let anybody
    // who can reach the port fill data/caddy with them).
    `\tfallback_sni ${sni}`,
    '}',
    // The bare https://:443 makes the site a catch-all: every Host reaches the app, which serves the page and
    // logs (origin-warn.ts) that sign-in and uploads need WEBADF_URL to be the address that was opened.
    `https://${c.host}:443, https://:443 {`,
    '\ttls internal',
    // Caddy's `tls internal` chain omits its root, and the app (uid 1000) cannot read Caddy's root-only pki directory.
    // So Caddy, which can, serves the one file at one path: another WebFloppy that this server shares a library with
    // pins it (src/lib/share/client.ts fetchLocalRootPin). The rewrite fixes the file; there is no browse, and the
    // .key files beside it are not reachable.
    '\thandle /.well-known/webadf-root.pem {',
    '\t\troot * /data/caddy/pki/authorities/local',
    '\t\trewrite * /root.crt',
    '\t\theader Content-Type application/x-pem-file',
    '\t\theader Cache-Control no-store',
    '\t\tfile_server',
    '\t}',
    '\thandle {',
    '\t\treverse_proxy app:3000',
    '\t}',
    '}',
    '',
  ].join('\n');
}
