import type { ChipKind } from '@/lib/send-ui';

/**
 * A small coloured state pill, from the palette's own bg/fg pairs (globals.css): amber for waiting, blue for
 * moving, green for done, red for failed, neutral (--track ground, --muted text) for withdrawn. Each pair is
 * dark-on-pale and AA as text. The shape is the board's pill (rounded-full, 9 px sides, 12 px semibold).
 * Sentence case, not the uppercase online/offline chips: these carry whole phrases.
 */
const CHIP: Record<ChipKind, { background: string; color: string }> = {
  amber: { background: 'var(--warning-bg)', color: 'var(--warning-fg)' },
  // No blue-bg token exists: a 12% tint of --accent-blue on --surface, so it is the same hue the library uses for "deduped".
  blue: { background: 'color-mix(in srgb, var(--accent-blue) 12%, var(--surface))', color: 'var(--accent-blue)' },
  green: { background: 'var(--success-bg)', color: 'var(--success-fg)' },
  red: { background: 'var(--danger-bg)', color: 'var(--danger-fg)' },
  neutral: { background: 'var(--track)', color: 'var(--muted)' },
};

export function StatusChip({ kind, children, className }: { kind: ChipKind; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex w-fit max-w-full items-center rounded-full px-[9px] py-0.5 text-[12px] font-semibold leading-tight ${className ?? ''}`}
          style={{ ...CHIP[kind], overflowWrap: 'anywhere' }}>
      {children}
    </span>
  );
}
