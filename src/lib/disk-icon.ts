/**
 * The disk icon's colours and sizing maths, from the approved board (ModernDisk.dc.html). Pure, so the
 * numbers are unit-tested (disk-icon.test.ts) and the component (components/ui/disk-icon.tsx) only draws.
 */

export type DiskColor = 'black' | 'blue' | 'grey' | 'red' | 'green' | 'cream';

/** `body` is the front disk; `back` the disk behind it in a stack, and the open write-protect tab. */
export const DISK_BODIES: Record<DiskColor, { body: string; back: string }> = {
  black: { body: '#232326', back: '#3A3A3F' },
  blue: { body: '#2F5D9A', back: '#1F416E' },
  grey: { body: '#8A8D93', back: '#6B6E74' },
  red: { body: '#B23A2E', back: '#7E2920' },
  green: { body: '#2F6B4F', back: '#204B37' },
  cream: { body: '#E2D9C6', back: '#C4B9A2' },
};

/**
 * Pixel sizes for an icon `size` px wide. The drawing's viewBox is 106x108, so the height follows the width;
 * the label (set line and title) is only drawn from 72 px up, where it can still be read.
 */
export function diskIconMetrics(size: number) {
  const w = size;
  return {
    w,
    h: Math.round((w * 108) / 106),
    showText: w >= 72,
    pad: Math.max(3, Math.round(w * 0.05)),
    gap: Math.max(2, Math.round(w * 0.025)),
    stripe: Math.max(2, Math.round(w * 0.018)),
    setSize: Math.max(7, Math.round(w * 0.56) / 10),
    titleSize: Math.max(9, Math.round(w * 1.05) / 10),
    badgeSize: Math.max(9, Math.round(w * 0.07)),
    shadowY: Math.max(1, Math.round(w * 0.05)),
    shadowBlur: Math.max(2, Math.round(w * 0.08)),
  };
}
