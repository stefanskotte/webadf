import { useId } from 'react';

/**
 * The board's drawing of an Amiga drive (ModernDevicesV2, spec §3): case, bezel, the four stripes, the slot, the
 * disk sliver, the LED and the DF0 engraving. A picture of hardware, so its colours are literal like the logo's;
 * only the LED follows the tokens (online / danger). Nothing on it is interactive: the board's screen is
 * `DriveGlass`, placed over it in percentages.
 *
 * `tall`: the 128x64 panel. The case is drawn 21 units taller (viewBox height 153) and everything from the bezel down
 * moves 21 units, so the taller glass fits in the top band. Gradient ids carry a per-instance suffix: an SVG id is
 * document-wide and two cards on a page must not share one.
 */
export const ART_W = 304;
export const ART_H = 132;
export const ART_TALL_EXTRA = 21;

export function DriveArt({ name, online, hasDisk, tall }: {
  name: string; online: boolean; hasDisk: boolean; tall: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const caseId = `mdCase${uid}`;
  const bezelId = `mdBezel${uid}`;
  const glowId = `mdGlow${uid}`;
  const dy = tall ? ART_TALL_EXTRA : 0;
  const led = online ? 'var(--online-dot)' : 'var(--danger-fg)';
  const aria = `${name}, ${online ? 'online' : 'offline'}, ${hasDisk ? 'disk in drive' : 'drive empty'}`;
  return (
    <svg viewBox={`0 0 ${ART_W} ${ART_H + dy}`} width="100%" role="img" aria-label={aria}
         style={{ display: 'block', height: 'auto', maxWidth: ART_W }}>
      <defs>
        <linearGradient id={caseId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F1EADB" /><stop offset="1" stopColor="#DCD2BD" />
        </linearGradient>
        <linearGradient id={bezelId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E4DBC7" /><stop offset="1" stopColor="#D3C8B1" />
        </linearGradient>
        <radialGradient id={glowId}>
          <stop offset="0" style={{ stopColor: led }} stopOpacity="0.65" />
          <stop offset="1" style={{ stopColor: led }} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="152" cy={124 + dy} rx="140" ry="7" fill="#24211B" opacity="0.10" />
      <rect x="6" y="6" width="292" height={112 + dy} rx="16" fill={`url(#${caseId})`} />
      <rect x="6.5" y="6.5" width="291" height={111 + dy} rx="15.5" fill="none" stroke="#ffffff" strokeOpacity="0.7" />
      <rect x="6" y="6" width="292" height={112 + dy} rx="16" fill="none" stroke="#BFB49C" strokeOpacity="0.6" />
      <g opacity="0.55">
        {[226, 233, 240, 247, 254, 261, 268, 275].map((x) => (
          <rect key={x} x={x} y="16" width="3" height="14" rx="1.5" fill="#BFB49C" />
        ))}
      </g>
      <g transform={`translate(0 ${dy})`}>
        <rect x="18" y="40" width="268" height="66" rx="10" fill={`url(#${bezelId})`} />
        <rect x="18" y="40" width="268" height="1.2" rx="0.6" fill="#ffffff" opacity="0.6" />
        <g transform="translate(30 58) skewX(-16)">
          <rect x="0" y="0" width="5" height="22" rx="1" fill="#D9453A" />
          <rect x="7" y="0" width="5" height="22" rx="1" fill="#EE8A2A" />
          <rect x="14" y="0" width="5" height="22" rx="1" fill="#4F9D4A" />
          <rect x="21" y="0" width="5" height="22" rx="1" fill="#2F6FB5" />
        </g>
        <rect x="70" y="58" width="168" height="12" rx="6" fill="#1C1B18" />
        <rect x="70" y="58" width="168" height="4" rx="2" fill="#000000" opacity="0.35" />
        <rect x="104" y="61" width="100" height="5" rx="1.5" fill="#3B3A36" opacity={hasDisk ? 1 : 0}
              data-sliver={hasDisk ? '1' : '0'} />
        <rect x="70" y="70.5" width="168" height="1" fill="#ffffff" opacity="0.5" />
        <circle cx="257" cy="64" r="12" fill={`url(#${glowId})`} />
        <circle cx="257" cy="64" r="3.6" style={{ fill: led }} />
        <rect x="244" y="80" width="28" height="12" rx="4" fill="#C9BDA4" />
        <rect x="244" y="80" width="28" height="10" rx="4" fill="#E3D9C5" />
        <path d="M258 82.5 l4 4 h-8 z" fill="#7A7262" />
        <text x="70" y="94" fontFamily="var(--font-mono), monospace" fontSize="9" letterSpacing="1.5" fill="#7A7262">DF0</text>
      </g>
      <rect x="34" y={118 + dy} width="40" height="5" rx="2.5" fill="#3B362C" opacity="0.8" />
      <rect x="230" y={118 + dy} width="40" height="5" rx="2.5" fill="#3B362C" opacity="0.8" />
    </svg>
  );
}
