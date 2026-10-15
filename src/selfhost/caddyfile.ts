import type { SelfhostConfig } from './config';

/** Self-hosting P2 (spec D6): one site on the container's port 443. */
export function renderCaddyfile(c: SelfhostConfig): string {
  if (c.domain) {
    return `${c.domain} {\n\treverse_proxy app:3000\n}\n`;
  }
  return [
    '{',
    '\tskip_install_trust',
    // A client opening an IP address sends no SNI; without this Caddy would look up a certificate for the
    // connection's local address (the container's own IP behind Docker's port mapping) and find none.
    `\tdefault_sni ${c.host}`,
    '}',
    `https://${c.host}:443 {`,
    '\ttls internal',
    '\treverse_proxy app:3000',
    '}',
    '',
  ].join('\n');
}
