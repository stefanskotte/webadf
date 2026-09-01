/**
 * The webadf mark: a 3.5" disk reduced to its chamfered corner, its shutter
 * and its label plate.
 *
 * ONE artwork, on every ground. The keyline is painted OUTSIDE the silhouette
 * (`paintOrder="stroke"` draws the stroke first, then the fill covers its
 * inner half), so the body can stay ink on the dark page gradient without a
 * separate reversed variant to keep in sync. A plain stroke would straddle the
 * path and eat 3 units into the body, thinning the shutter and shifting the
 * label plate.
 *
 * `--grad-4` (#c8cfd3) rather than `--on-dark`: at #eef3f6 the keyline read as
 * white and glared on the header. It is a step down the app's own gradient
 * ramp, so it is not an invented colour — and it drives the label plate too,
 * so the mark has one light value rather than two.
 *
 * Colours are literal, not `var(--…)`: this renders inside `icon.svg` and the
 * favicon as well, where the app's custom properties do not exist.
 */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  // Below ~40px the slot and the two ruled lines on the label close up into
  // mud, so they come off — the favicon is this same drawing with two details
  // removed, never a redraw. The keyline goes up a notch to compensate, since
  // a sub-pixel outline is the first thing a browser tab throws away.
  const detailed = size >= 40;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 5 H43.5 L59 20.5 V52 A7 7 0 0 1 52 59 H12 A7 7 0 0 1 5 52 V12 A7 7 0 0 1 12 5 Z"
        fill="#16232f"
        stroke="#c8cfd3"
        strokeWidth={detailed ? 6 : 7}
        strokeLinejoin="round"
        paintOrder="stroke"
      />
      <path d="M22 5 H41 V23 H22 Z" fill="#f5822e" />
      {detailed && <rect x="32.5" y="8.5" width="5" height="11" rx="1.6" fill="#16232f" />}
      <rect x="14" y="33" width="36" height="20" rx="3.5" fill="#c8cfd3" />
      {detailed && (
        <>
          <rect x="18.5" y="39" width="22" height="2.6" rx="1.3" fill="#5f6874" />
          <rect x="18.5" y="45" width="14" height="2.6" rx="1.3" fill="#8d97a1" />
        </>
      )}
    </svg>
  );
}
