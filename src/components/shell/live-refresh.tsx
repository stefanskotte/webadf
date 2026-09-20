'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { isIdle, livePollDelay } from '@/lib/live-poll';

/** What counts as "someone is using this tab". Passive, so scrolling stays smooth. */
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart', 'pointermove'] as const;

/** pointermove fires on every pixel of movement; anything less than this since
 * the last recorded input is not worth a ref write -- someone watching this
 * page on a second monitor without touching anything still counts as "in
 * use" as long as the mouse moves, at the cost of one comparison per event
 * rather than one write. */
const POINTERMOVE_THROTTLE_MS = 30_000;

function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  // The header search box (SearchBox) marks its input `data-live-ok`: it
  // lives in the layout, focus can linger there for reasons that have
  // nothing to do with mid-edit text (a result panel left open, a stray
  // click), and that must not hold back live updates for the rest of the
  // page the way a genuine rename field should.
  if (el.hasAttribute('data-live-ok')) return false;
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
 *
 * The rate follows whether this tab is being used (src/lib/live-poll.ts):
 * 3 s while it is, 30 s after ten minutes without input. A visible tab polls
 * for as long as it is open, and at 3 s around the clock that is ~1,200
 * requests an hour that also keep the database awake for nobody. Returning
 * to the tab polls at once rather than waiting out the long delay already
 * scheduled, so coming back never costs 30 s of staleness.
 *
 * Two races are known and accepted rather than closed. First, the layout's
 * server render and this component's client mount are not the same instant:
 * `Date.now()` inside the layout's query and the millisecond the browser
 * paints can straddle a change by a few ms either way, same as any
 * server-rendered page. Second, deploy skew: an old tab, still running the
 * previous build's client code, can poll a server already running the new
 * build and see a fingerprint that differs from the new deploy alone; its
 * `router.refresh()` then fetches an RSC payload the old client cannot parse,
 * which Next.js turns into a hard reload -- surprising once, but it leaves
 * the tab on the new build, which is what the reload was for.
 */
export function LiveRefresh({ initial }: { initial: string }) {
  const router = useRouter();
  const last = useRef(initial);
  const owed = useRef(false);        // a change seen while the user was typing
  const inFlight = useRef(false);
  const lastInputAt = useRef(performance.now());

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
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    async function check() {
      if (stopped || inFlight.current || document.visibilityState !== 'visible') return;
      inFlight.current = true;
      try {
        const res = await fetch('/api/live-state', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        // Cleanup can land while this fetch is still in flight (a fast
        // unmount, or React's dev-mode double-invoke discarding this effect
        // instance); re-checked here, after the only await, so a response
        // that arrives afterward cannot mutate `last`/`owed` or call
        // router.refresh() for a layout this component has already
        // navigated away from.
        if (stopped || !res.ok) return;
        const { fingerprint } = (await res.json()) as { fingerprint?: string };
        if (stopped || typeof fingerprint !== 'string') return;
        if (fingerprint !== last.current) { last.current = fingerprint; owed.current = true; }
        if (owed.current && !typing()) { owed.current = false; router.refresh(); }
      } catch {
        // Offline, signed out, a deploy: say nothing, try again next tick.
      } finally {
        inFlight.current = false;
      }
    }

    // One timer at a time, re-armed after each tick at whatever the rate is
    // by then -- not a fixed interval, so a tab that goes idle slows down
    // without being torn down and rebuilt.
    function arm() {
      if (stopped || timer !== null || document.visibilityState !== 'visible') return;
      timer = setTimeout(async () => {
        timer = null;
        try { await check(); } finally { arm(); }
      }, livePollDelay(performance.now(), lastInputAt.current));
    }
    function disarm() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }

    function onInput(e: Event) {
      const now = performance.now();
      // pointermove fires on every pixel: without this, watching the screen
      // while moving the mouse would write the ref hundreds of times a
      // second. Every other input type still updates on every event.
      if (e.type === 'pointermove' && now - lastInputAt.current < POINTERMOVE_THROTTLE_MS) return;
      const wasIdle = isIdle(now, lastInputAt.current);
      lastInputAt.current = now;
      // Coming back to a tab that had slowed down: it may be up to 30 s into
      // a long wait, so poll now and re-arm at the fast rate instead of
      // serving stale state until that timer happens to fire.
      if (wasIdle) { disarm(); void check().finally(arm); }
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') {
        // Returning to a hidden tab is itself a sign of use: a tab brought to
        // the front is being looked at, whatever the last pointer event says.
        lastInputAt.current = performance.now();
        void check().finally(arm);
      } else {
        disarm();
      }
    }

    void check().finally(arm);
    for (const e of INPUT_EVENTS) {
      document.addEventListener(e, onInput, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      disarm();
      for (const e of INPUT_EVENTS) {
        document.removeEventListener(e, onInput, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return null;
}
