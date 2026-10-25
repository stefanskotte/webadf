/**
 * The WebFloppy mark: a 3.5" disk with its chamfered corner, the metal
 * shutter and the label carrying four stripes, drawn from the approved
 * header board (ModernHeader).
 *
 * Drawn for the light ground: an ink body with no keyline. (The old mark
 * needed an outline to stand off the dark page gradient; that ground is gone.)
 *
 * tone="light" draws it for an ink ground (the sign-in hero).
 *
 * Colours are literal, not `var(--…)`: this same drawing is `icon.svg`, where
 * the app's custom properties do not exist.
 */
export function Logo({ size = 24, className, tone = 'dark' }: { size?: number; className?: string; tone?: 'dark' | 'light' }) {
  // Below ~40px the shutter's slot closes up into mud, so it comes off -- the
  // favicon is this same drawing without it, never a redraw.
  const detailed = size >= 40;
  // `light` is the board's inverted mark for the ink sign-in hero (C5 spec §6.1): a surface body and an ink lower
  // label. The favicon (icon.svg) and the header keep the dark one.
  const body = tone === 'light' ? '#FFFDF8' : '#24211B';
  const label = tone === 'light' ? '#24211B' : '#FBF8F1';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 106 108"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(0 6)">
        <path d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" fill={body} />
        <rect x="25" y="0" width="52" height="35" rx="2" fill="#D6D9DD" />
        {detailed && <rect x="58" y="5" width="10" height="25" rx="1.5" fill={body} />}
        <path d="M12 48 H88 V102 H12 Z" fill={label} />
        <rect x="20" y="58" width="15" height="6" rx="1" fill="#D9453A" />
        <rect x="37" y="58" width="15" height="6" rx="1" fill="#EE8A2A" />
        <rect x="54" y="58" width="15" height="6" rx="1" fill="#4F9D4A" />
        <rect x="71" y="58" width="10" height="6" rx="1" fill="#2F6FB5" />
      </g>
    </svg>
  );
}
