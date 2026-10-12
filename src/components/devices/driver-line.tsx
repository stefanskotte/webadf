'use client';
import { useEffect, useState } from 'react';
import { driverLine } from '@/lib/network-checklist';

const TICK_MS = 5_000;

/** The driver line with a live age. The first render uses the server's `now` (no hydration mismatch); an effect
 *  then ticks the clock. The talking/quiet switch is still driven by the page's live fingerprint, which refreshes
 *  the props; `Math.max` keeps a fresh server `now` from being overruled by an older tick. */
export function DriverLine({ id, seenAtMs, serverNow }: { id: string; seenAtMs: number | null; serverNow: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  const l = driverLine(seenAtMs === null ? null : new Date(seenAtMs), Math.max(serverNow, tick));
  return (
    <span data-testid={`net-driver-${id}`} data-ok={String(l.ok)}
          style={{ color: l.ok ? 'var(--ink)' : 'var(--amber-text)' }}>
      {l.ok ? '✓ ' : '• '}{l.text}
    </span>
  );
}
