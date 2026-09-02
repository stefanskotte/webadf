'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLinkStatus } from 'next/link';

/**
 * Navigation feedback for the whole shell: a moving bar at the top of the
 * viewport and a gentle dim over the page under it.
 *
 * WHY THIS EXISTS AT ALL. Next's own docs name the symptom: a dynamic route
 * with no loading.tsx blocks on the server response before it renders, so the
 * app "appears unresponsive" -- you click Devices, nothing moves, you click
 * again. Every route here is `force-dynamic` and none had a loading.tsx, so
 * that was every navigation in the app.
 *
 * WHY NOT A GLOBAL CLICK LISTENER, the usual way this gets built: /library
 * already runs one document-level capture listener for dnd-kit, and that
 * interaction was expensive enough to earn its own section in HANDOFF. A
 * second one racing it, on the same elements that are also drag handles, is
 * exactly the bug that would surface only in production on a card drag.
 *
 * Instead each <Link> reports its own pending state through useLinkStatus()
 * (see ./link.tsx), and programmatic navigation goes through navigate()
 * below, which wraps router.push in a transition so React reports the pending
 * state itself. Neither path needs a timer, a pathname watcher, or a guess
 * about when a navigation ended.
 */

interface NavProgressValue {
  /** Marks a link navigation in flight. Returns the matching "it finished". */
  begin: () => () => void;
  /**
   * router.push, wrapped so the shell knows about it. Prefer this to calling
   * router.push directly from inside the shell: a bare push reports no
   * pending state, and there is no completion callback to fake one with.
   */
  navigate: (href: string) => void;
}

const NavProgressContext = createContext<NavProgressValue | null>(null);

export function useNavProgress(): NavProgressValue {
  const ctx = useContext(NavProgressContext);
  const router = useRouter();
  // A working fallback rather than a throw: this is decoration. A component
  // rendered outside the provider -- the (auth) shell, a test harness -- must
  // still navigate, just without the bar.
  const fallback = useMemo<NavProgressValue>(() => ({
    begin: () => () => {},
    navigate: (href: string) => router.push(href),
  }), [router]);
  return ctx ?? fallback;
}

export function NavProgressProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // A COUNT, not a boolean. Hover prefetch and a click can leave more than one
  // link pending at once, and a boolean lets whichever settles first switch
  // the bar off while the navigation the user is waiting on is still running.
  const [inFlight, setInFlight] = useState(0);
  // React's own pending state for programmatic navigation. router.push inside
  // a transition stays pending until the new route commits, which is exactly
  // the window the bar should cover -- and it needs no cleanup of its own.
  const [pushPending, startTransition] = useTransition();

  const begin = useCallback(() => {
    setInFlight((n) => n + 1);
    let done = false;
    return () => {
      // Guarded: an effect cleanup can run more than once (StrictMode, a
      // re-mount), and an unbalanced decrement would take the count negative
      // and wedge the bar off for the rest of the session.
      if (done) return;
      done = true;
      setInFlight((n) => Math.max(0, n - 1));
    };
  }, []);

  const navigate = useCallback((href: string) => {
    startTransition(() => { router.push(href); });
  }, [router]);

  const pending = inFlight > 0 || pushPending;

  const value = useMemo<NavProgressValue>(() => ({ begin, navigate }), [begin, navigate]);

  return (
    <NavProgressContext.Provider value={value}>
      {children}
      <NavProgressOverlay pending={pending} />
    </NavProgressContext.Provider>
  );
}

/**
 * Nothing appears for a navigation faster than this. Prefetched routes land
 * well inside it, and a bar that flashes for 60ms reads as a glitch rather
 * than as feedback -- worse than showing nothing, because the eye catches the
 * flicker without being able to resolve it.
 *
 * It is a CSS transition-delay, not a timer: a timer would mean setting state
 * from an effect on every navigation, and the delay only ever applies to
 * APPEARING. Going away is immediate, because a scrim that lingers after the
 * page has painted is the one thing worse than no scrim.
 */
const APPEAR_DELAY_MS = 150;

function NavProgressOverlay({ pending }: { pending: boolean }) {
  const show = pending
    ? `opacity 220ms ease ${APPEAR_DELAY_MS}ms`
    : 'opacity 160ms ease';
  return (
    <>
      {/* The dim is a FIXED scrim, not an opacity on the content. Setting
          opacity on a wrapper creates a stacking context, which would pull the
          search panel (z-50) and dnd-kit's drag overlay inside it and change
          what paints over what on /library. pointer-events:none so it never
          swallows a click -- including from Playwright, whose actionability
          check would otherwise report every button as covered. */}
      <div
        aria-hidden
        data-testid="nav-scrim"
        className="pointer-events-none fixed inset-0 z-40"
        style={{
          background: 'rgb(11 18 28 / 0.28)',
          opacity: pending ? 1 : 0,
          transition: show,
        }}
      />
      <div
        aria-hidden
        data-testid="nav-bar"
        className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px] overflow-hidden"
        style={{ opacity: pending ? 1 : 0, transition: show }}
      >
        {/* Indeterminate on purpose. We do not know how far along a server
            render is, and a bar that creeps to 90% and waits is a fiction the
            user learns to distrust. A travelling segment says "working"
            without claiming to know how much is left. --accent-amber is the
            app's accent and is fill-only by decree, which is exactly what
            this is. Paused rather than unmounted when idle, so nothing
            animates off-screen for the life of the session. */}
        <div
          className="nav-progress-run h-full w-1/3"
          style={{ background: 'var(--accent-amber)', animationPlayState: pending ? 'running' : 'paused' }}
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? 'Loading page' : ''}
      </span>
    </>
  );
}

/**
 * Reports one <Link>'s pending state to the provider.
 *
 * MUST be rendered as a child of <Link>: useLinkStatus() reads a context that
 * the Link itself provides, so a parent cannot read it and pass it down.
 * Returns null -- it runs hooks and renders nothing, which is what keeps a
 * reporting link from gaining a stray element inside a flex row with a gap.
 */
export function PendingReporter() {
  const { pending } = useLinkStatus();
  const { begin } = useNavProgress();
  useEffect(() => {
    if (!pending) return;
    return begin();
  }, [pending, begin]);
  return null;
}
