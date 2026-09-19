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
 */
export function LiveRefresh() {
  const router = useRouter();
  const last = useRef<string | null>(null);
  const owed = useRef(false);        // a change seen while the user was typing
  const inFlight = useRef(false);

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
        if (last.current === null) { last.current = fingerprint; return; }
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
