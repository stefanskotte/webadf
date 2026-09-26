'use client';

import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The header's left zone: the wordmark, then a lane that centres the drive
 * chips (or the compact "Drives" control) in the free space between the
 * wordmark and the viewport-centred nav pill (operator, 2026-09-26: "the logo
 * looks pushed into a corner").
 *
 * The geometry is CSS; only the pill's WIDTH is measured. The pill is centred
 * on the header, and the header's padding is symmetric, so the pill's left
 * edge always sits at 50% of the header's content box minus half the pill.
 * This zone starts at the content box's left edge and is capped at
 * `50% - pill/2 - 1rem`, so its right edge is always one gap short of the
 * pill, at every viewport width, with no script involved in a resize. Inside
 * it the lane is flex-1 and justify-center, which is what makes the gap to
 * the wordmark and the gap to the pill come out equal.
 *
 * Why not CSS alone: nothing in CSS can read the pill's intrinsic width into
 * a sibling's size short of anchor positioning (not in every browser we
 * support), and the pill changes width with the Admin item and would with any
 * label change. Why not measure the pill's left edge instead: that moves on
 * every resize, so the chips would lag a frame behind the pill while a window
 * is dragged; its width changes only when its contents do.
 *
 * `pillEstimate` is the pill's width as measured on 2026-09-26 (248px, 322px
 * with Admin), used ONLY for the server-rendered first paint so the chips do
 * not jump sideways on hydration; the ResizeObserver replaces it with the
 * real width before the first client paint (layout effect), and again
 * whenever the pill changes size (web font swap, labels). Server and client
 * start from the same number, so hydration sees identical markup.
 *
 * max-width rather than width, on a flex-1 item: when there is not room for
 * the chips at all (narrow sm widths), min-width:auto wins over max-width and
 * the zone is exactly as wide as its content -- the same layout the header
 * had before this zone existed -- rather than squashing a chip or taking
 * width from the search box. Below sm the cap is off: the zone fills the
 * wordmark's line and the compact control keeps its own ml-auto to sit at
 * the right end of it, as before.
 */
export function HeaderStart({ pillEstimate, children }: { pillEstimate: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pillWidth, setPillWidth] = useState(pillEstimate);

  useLayoutEffect(() => {
    const pill = ref.current?.closest('header')?.querySelector<HTMLElement>('[data-nav-pill]');
    if (!pill) return;
    const read = () => {
      const w = pill.getBoundingClientRect().width;
      // 0 while the pill is display:none (never, today) -- keep the last good value.
      if (w > 0) setPillWidth(Math.round(w * 100) / 100);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(pill);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-testid="header-start"
      className="flex flex-1 items-center gap-3 sm:max-w-[calc(50%-var(--nav-pill-w)/2-1rem)] sm:gap-4"
      style={{ '--nav-pill-w': `${pillWidth}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

