import type { SelfhostConfig } from './config';

/** Self-hosting P2 (spec D6): one site on the container's port 443. */
export function renderCaddyfile(c: SelfhostConfig): string {
  if (c.domain) {
    return `${c.domain} {\n\treverse_proxy app:3000\n}\n`;
  }
  return [
    '{',
    '\tskip_install_trust',
    '}',
    `https://${c.host}:443 {`,
    '\ttls internal',
    '\treverse_proxy app:3000',
    '}',
    '',
  ].join('\n');
}
