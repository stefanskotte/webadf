'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-render the server component tree on an interval, but ONLY while something
 * is actually outstanding.
 *
 * `active` is false whenever every device has converged, and then no timer
 * exists at all -- not a timer that fires and does nothing. A tab left open
 * overnight on a settled fleet costs nothing, which is the common case.
 *
 * The data-testid is how e2e proves the timer is gone rather than merely quiet.
 */
export function LiveRefresh({ active, intervalMs = 5_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);

  return <span data-testid="live-refresh" data-active={active ? 'true' : 'false'} className="sr-only" />;
}
