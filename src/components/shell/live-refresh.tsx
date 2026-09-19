'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/** Spec decision L2. */
export const LIVE_POLL_MS = 3000;

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

/**
 * Keeps this tab's device state current without a reload (spec
 * 2026-09-19-live-device-state-design.md). Renders nothing.
 *
 * `initial` is the fingerprint the server computed for THIS render (the app
 * layout, with the same `liveFingerprint`/`liveStateRows` the poll route
 * uses) -- what the DOM already reflects, not "whatever the client's first
 * fetch happens to see". The baseline used to be set by that first fetch
 * instead: a change landing between the server render and that fetch (client
 * hydration plus one round trip, unbounded on a slow device or network)
 * would get folded straight into the baseline and never surface until some
 * LATER, unrelated change gave the poller something to compare against.
 * Seeding the baseline from the server closes that window to zero: the very
 * first tick already compares against ground truth instead of just
 * recording it.
 */
export function LiveRefresh({ initial }: { initial: string }) {
  const router = useRouter();
  const last = useRef(initial);
  const owed = useRef(false);        // a change seen while the user was typing
  const inFlight = useRef(false);

  // A fresh `initial` means a new server render landed (our own
  // router.refresh() below, or a full navigation) and already reflects
  // whatever caused it -- adopt it as the new baseline with nothing owed,
  // rather than let the next poll tick compare against a now-stale value and
  // refresh a second time for the same change.
  useEffect(() => {
    last.current = initial;
    owed.current = false;
  }, [initial]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    async function check() {
      if (inFlight.current || document.visibilityState !== 'visible') return;
      inFlight.current = true;
      try {
        const res = await fetch('/api/live-state', { cache: 'no-store' });
        if (!res.ok) return;
        const { fingerprint } = (await res.json()) as { fingerprint?: string };
        if (typeof fingerprint !== 'string') return;
        if (fingerprint !== last.current) { last.current = fingerprint; owed.current = true; }
        if (owed.current && !typing()) { owed.current = false; router.refresh(); }
      } catch {
        // Offline, signed out, a deploy: say nothing, try again next tick.
      } finally {
        inFlight.current = false;
      }
    }

    function start() {
      if (timer === null) timer = setInterval(check, LIVE_POLL_MS);
    }
    function stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') { void check(); start(); } else stop();
    }

    void check();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [router]);

  return null;
}
