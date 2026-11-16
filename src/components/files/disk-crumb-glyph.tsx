/**
 * The mark before the crumb that is the disk image itself (isDiskCrumb in pane-rules), so "LIBRARY: Empty / Disk 1"
 * reads as a disk and not as a folder named Disk 1 (tester report 2026-11-15: "I have to upload them to disk1/").
 * The WebFloppy disk's outline (logo.tsx, DiskIcon: the chamfered corner, the shutter, the label) in currentColor, so
 * it takes the crumb's colour on the ink title bar and on the soft one alike. Decorative: the crumb carries the words.
 * A title's disk rows (pane.tsx) and the Copy to… picker's draw it too, in place of a DSK chip: the same sign outside
 * the disk as inside it (ruling 2026-11-15), `size` 14 and their own spacing in `className`.
 */
export function DiskCrumbGlyph({ testId, size = 12, className = 'mr-1 ml-0.5' }: { testId?: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="-6 -6 118 120" aria-hidden="true" focusable="false" data-testid={testId}
         className={`${className} inline-block shrink-0 align-[-1px]`}>
      <path d="M5 0 H88 L100 12 V97 Q100 102 95 102 H5 Q0 102 0 97 V5 Q0 0 5 0 Z" transform="translate(0 6)"
            fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round" />
      <rect x="27" y="6" width="48" height="30" rx="2" fill="currentColor" />
      <rect x="18" y="60" width="64" height="40" rx="3" fill="none" stroke="currentColor" strokeWidth="9" />
    </svg>
  );
}
