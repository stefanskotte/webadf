'use client';

// The typeahead pill in both shells' headers. Fires on every keystroke
// against /api/search, so the debounce and the abort below are load-bearing:
// without them a fast typist has several requests in flight at once and they
// resolve in arrival order, not the order they were sent -- see the comments
// on the effect for the exact failure this guards against.
//
// Deliberately does NOT import from '@/lib/search' -- that module reaches
// '@/db', and this is a client component: importing it would drag the
// database into the browser bundle. The two result shapes are redeclared
// below instead, kept in sync with src/lib/search.ts by hand.

import { useEffect, useRef, useState } from 'react';
import { useNavProgress } from './nav-progress';

interface SearchTitle {
  id: string;
  title: string;
  year: number | null;
  publisher: string | null;
  diskCount: number;
}
interface SearchCollectionHit {
  id: string;
  name: string;
  gameCount: number;
}
interface SearchResults {
  titles: SearchTitle[];
  collections: SearchCollectionHit[];
}

const EMPTY_RESULTS: SearchResults = { titles: [], collections: [] };

export function SearchBox() {
  const { navigate } = useNavProgress();
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The trimmed query the last COMPLETED (non-aborted, non-superseded)
  // response actually answered, or null before any response has landed for
  // the current query. showEmpty below is gated on this equalling the
  // current input -- otherwise the empty-state line flashes for the entire
  // 150ms debounce + round trip of every search, before a request has even
  // been made, and a broken /api/search would never be caught by a test
  // that only looks for that line.
  const [respondedQuery, setRespondedQuery] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The trimmed query as of the most recent keystroke, kept outside React
  // state so the in-flight fetch's callback can read it synchronously.
  // Aborting is not instantaneous, so this is the belt-and-braces guard the
  // brief asks for: a response for an older query can still land after a
  // newer one starts, and comparing against this ref (not just
  // controller.signal.aborted) is what catches it.
  const currentQueryRef = useRef('');

  // Abort/clear everything search-related, WITHOUT touching `q` itself.
  // Shared by the "box is now empty" path and the full reset() below, so
  // that a whitespace-only value can still be cleared of search state
  // without also stomping the literal characters the user typed (see
  // onChange: `q` is controlled, so wiping it here would swallow a leading
  // space as it's typed).
  function clearSearchState() {
    abortRef.current?.abort();
    currentQueryRef.current = '';
    setResults(EMPTY_RESULTS);
    setRespondedQuery(null);
    setError(null);
    setHighlight(0);
  }

  // Every path that DISMISSES the panel (Escape, selecting a result) funnels
  // through here, so abort/clear/reset-highlight/clear-q can never be
  // forgotten on one of them. Missing this on even one path leaves a stale
  // request free to land later and repopulate a panel the user believes is
  // closed, or worse, an open one for a different query -- navigating does
  // not unmount SearchBox, since it lives in the layout.
  function reset() {
    clearSearchState();
    setQ('');
  }

  useEffect(() => {
    const query = q.trim();
    // Clearing the field back to empty is handled synchronously by
    // clearSearchState()/reset(), not here -- setting state directly in an
    // effect body (rather than inside the async callback below) is exactly
    // the pattern react-hooks/set-state-in-effect flags, and there is
    // nothing to synchronize with an external system for "the box is empty".
    if (query === '') return;

    const timer = setTimeout(async () => {
      // Abort the PREVIOUS request, not this one. Without this a fast typist
      // has several in flight at once and they resolve in arrival order, not
      // in the order they were sent.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        // A superseded response still comes back !ok sometimes -- don't let
        // an old request paint an error over what the user is typing now.
        if (!res.ok) {
          if (!controller.signal.aborted && currentQueryRef.current === query) {
            setError('Search is unavailable');
          }
          return;
        }
        const body = (await res.json()) as SearchResults;
        // Belt and braces over the abort: aborting is not instantaneous, and
        // a response for an older query can still land after a newer one.
        // Compare against the CURRENT input (currentQueryRef, updated on
        // every keystroke) and drop anything that no longer matches, in
        // addition to the abort check.
        if (controller.signal.aborted || currentQueryRef.current !== query) return;
        setResults(body);
        setRespondedQuery(query);
        setHighlight(0); // Enter right after typing always opens the top row
        setError(null);
      } catch (e) {
        // An abort is the normal path here, not a failure -- never surface
        // it, and never surface a stale request's failure either.
        if ((e as Error).name !== 'AbortError' && currentQueryRef.current === query) {
          setError('Could not reach the server');
        }
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [q]);

  // Unmounting mid-flight must not leave a fetch running against a dead component.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Global shortcuts: Cmd/Ctrl+K always focuses; `/` focuses UNLESS focus is
  // already inside another input, textarea or contenteditable -- otherwise
  // this steals the key from the collection rename field and the
  // create-collection input on /library.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (e.key === '/') {
        const active = document.activeElement;
        const tag = active?.tagName;
        const isEditable =
          tag === 'INPUT' || tag === 'TEXTAREA' || (active as HTMLElement | null)?.isContentEditable;
        if (isEditable) return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [focused, setFocused] = useState(false);

  const trimmed = q.trim();
  // While an error is showing, the rows behind it are stale and must not be
  // navigable -- an empty flat list here also disarms ArrowUp/ArrowDown/Enter.
  const flat: Array<
    | { kind: 'title'; item: SearchTitle }
    | { kind: 'collection'; item: SearchCollectionHit }
  > = error
    ? []
    : [
        ...results.titles.map((item) => ({ kind: 'title' as const, item })),
        ...results.collections.map((item) => ({ kind: 'collection' as const, item })),
      ];
  const showEmpty = trimmed !== '' && !error && respondedQuery === trimmed && flat.length === 0;
  // The panel itself is gated on there being something to put in it. Without
  // this, the bordered box renders empty (no rows, no error, no empty-state
  // line yet -- respondedQuery hasn't caught up) for the whole debounce plus
  // round trip of every single search: a small blank box flashing under the
  // pill on the first keystroke.
  const showPanel = trimmed !== '' && (error !== null || flat.length > 0 || showEmpty);

  function onChange(value: string) {
    // `q` is a controlled input's value, so it must always take the literal
    // characters typed -- including a leading space on an otherwise-empty
    // box, which trims to ''. Clearing search state below must not clear
    // `q` too, or that space would never render.
    setQ(value);
    const trimmedValue = value.trim();
    if (trimmedValue === '') {
      // Nothing left to search for. Clear search state right away rather
      // than waiting on the debounce -- an empty (or whitespace-only) query
      // renders no panel at all (a different thing from an empty result
      // set), so stale rows must not linger under it.
      clearSearchState();
      return;
    }
    currentQueryRef.current = trimmedValue;
  }

  function select(entry: (typeof flat)[number]) {
    // navigate(), not router.push: a bare push reports no pending state, and
    // this is the one navigation in the app where the panel vanishes on the
    // same click, so without the bar nothing on screen confirms it landed.
    if (entry.kind === 'title') navigate(`/games/${entry.item.id}`);
    else navigate(`/library?collection=${entry.item.id}`);
    // SearchBox lives in the layout, so navigating does not unmount it --
    // without reset() here the request for whatever was typed keeps running
    // and can repopulate the panel with the PREVIOUS search's rows the next
    // time it opens.
    reset();
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      if (flat.length === 0) return;
      e.preventDefault();
      setHighlight((h) => (h + 1) % flat.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (flat.length === 0) return;
      e.preventDefault();
      setHighlight((h) => (h - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === 'Enter') {
      const entry = flat[highlight];
      if (entry) {
        e.preventDefault();
        select(entry);
      }
      return;
    }
    if (e.key === 'Escape') {
      reset();
      inputRef.current?.blur();
    }
  }

  return (
    // Full width below sm: the header wraps the search box onto a line of its
    // own there, and a shrink-to-fit box would leave that line mostly empty
    // while the input it contains stayed too narrow to read a query in.
    <div className="relative w-full sm:w-auto">
      <input
        ref={inputRef}
        data-testid="search-input"
        // Tells LiveRefresh's `typing()` guard (src/components/shell/live-refresh.tsx)
        // not to treat focus here as "editing a form on the page". This box
        // lives in the layout, not on a page, and focus can linger in it for
        // reasons that have nothing to do with an in-progress edit (a result
        // panel left open, a stray click) -- that must not hold back live
        // updates for the rest of the page the way a genuine rename field
        // should.
        data-live-ok
        aria-label="Search titles"
        title="Search titles — press / to focus"
        placeholder="Search titles"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        // pr-9 leaves room for the key hint; without it a long query runs
        // underneath the badge instead of scrolling behind the pill's edge.
        // w-48, not w-56. The admin shell carries the operator's email and a
        // back-link beside this box, and at w-56 the centred nav pill and this
        // input overlapped by 15px at 1280 (measured, both shells). 192px
        // still holds the placeholder and the key hint with room to spare.
        // Below sm none of that applies -- the pill has left the header for
        // the bottom bar -- and 192px would waste the line the box now has to
        // itself, so it takes the whole of it.
        className="h-[34px] w-full rounded-full border pl-4 pr-4 text-[13px] outline-none transition-colors sm:w-48 sm:pr-9"
        style={{
          background: 'rgb(255 255 255 / 0.12)',
          borderColor: 'rgb(255 255 255 / 0.16)',
          color: 'var(--on-dark)',
        }}
      />

      {/* The "/" shortcut has always worked; nothing on screen said so, which
          for most people is the same as it not existing. Shown only while the
          box is idle -- once it is focused or has a query in it, the hint has
          served its purpose and would just be sitting in the way of the text.
          aria-hidden because the same thing is already announced properly by
          the input's title attribute; a screen reader does not need "slash"
          read out as content. */}
      {!focused && q === '' && (
        <kbd
          aria-hidden
          data-testid="search-hint"
          // hidden below sm: it advertises a KEY, and a phone has no keyboard
          // to press it with -- on a touch device it is decoration sitting on
          // top of the input's text. The shortcut itself still works for
          // anything with a keyboard attached at any width.
          className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border px-1.5 font-mono text-[11px] leading-[15px] sm:block"
          style={{
            background: 'rgb(255 255 255 / 0.10)',
            borderColor: 'rgb(255 255 255 / 0.22)',
            color: 'rgb(233 240 244 / 0.78)',
          }}
        >
          /
        </kbd>
      )}

      {showPanel && (
        // OPAQUE, not --glass-strong. The panel is anchored at top-[42px],
        // so its upper region composites over the page gradient's DARK band
        // (--grad-top / --grad-2), not the pale band --muted-2/--faint were
        // contrast-checked against (see the ramp's comment in globals.css) --
        // translucent here measured ~4.1:1 / ~3.8:1, under AA for this
        // small text. #f1f4f5 is that exact pale band, painted opaque: it
        // reproduces the composited backdrop the ramp was tuned against
        // regardless of where the panel sits on the gradient, which is a
        // stronger fix than re-tuning two token values for one placement.
        // Recomputed against #f1f4f5: --ink 14.44:1, --muted 6.49:1,
        // --muted-2 5.11:1, --faint 4.74:1 -- all clear 4.5:1 on the PLAIN
        // panel. But the highlighted row (see `highlighted` below) adds a
        // rgb(30 45 60 / 0.08) overlay on top of that, compositing to about
        // #e0e4e6, and highlight defaults to 0 -- the top row is highlighted
        // whenever any row shows, i.e. this is the default state, not an
        // edge case. On that composited surface --muted-2 drops to 4.41:1,
        // under AA. The per-row metadata line below therefore uses --muted
        // (6.49:1 on #f1f4f5, 5.60:1 on the highlighted #e0e4e6), not
        // --muted-2, so it clears AA either way. --faint is unaffected and
        // stays as-is: it is only used on the group labels, which are never
        // highlighted.
        <div
          data-testid="search-panel"
          // The panel is anchored right-0 and grows leftwards, so on a narrow
          // screen a fixed 20rem puts its LEFT edge off-canvas -- and the
          // titles are left-aligned inside it, so that is the half a reader
          // needs. 20rem still fits at 390px; it stops fitting on the 320px
          // phones below that, and the min() is what makes those degrade to a
          // narrower panel rather than a truncated one. Above sm it always
          // resolves to 20rem, which is today's w-80 exactly.
          className="absolute right-0 top-[42px] z-50 w-[min(20rem,calc(100vw-2rem))] rounded-xl border p-1.5 sm:w-80"
          style={{
            background: '#f1f4f5',
            borderColor: 'var(--hairline-strong)',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          {error ? (
            <div className="px-2 py-1.5 text-[12.5px]" style={{ color: 'var(--ink)' }}>
              {error}
            </div>
          ) : showEmpty ? (
            <div
              data-testid="search-empty"
              className="px-2 py-1.5 text-[12.5px]"
              style={{ color: 'var(--muted-2)' }}
            >
              No titles match &quot;{trimmed}&quot;
            </div>
          ) : (
            <>
              {results.titles.length > 0 && (
                <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.09em]" style={{ color: 'var(--faint)' }}>
                  Titles
                </div>
              )}
              {results.titles.map((t) => {
                const index = flat.findIndex((e) => e.kind === 'title' && e.item.id === t.id);
                const highlighted = index === highlight;
                return (
                  <button
                    key={t.id}
                    type="button"
                    data-testid="search-result"
                    data-result-kind="title"
                    data-result-id={t.id}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => select({ kind: 'title', item: t })}
                    className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left"
                    style={highlighted ? { background: 'rgb(30 45 60 / 0.08)' } : undefined}
                  >
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                      {t.title}
                    </span>
                    <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted)' }}>
                      {[t.year, t.publisher, `${t.diskCount} disk${t.diskCount === 1 ? '' : 's'}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                );
              })}

              {results.collections.length > 0 && (
                <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.09em]" style={{ color: 'var(--faint)' }}>
                  Collections
                </div>
              )}
              {results.collections.map((c) => {
                const index = flat.findIndex((e) => e.kind === 'collection' && e.item.id === c.id);
                const highlighted = index === highlight;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-testid="search-result"
                    data-result-kind="collection"
                    data-result-id={c.id}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => select({ kind: 'collection', item: c })}
                    className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left"
                    style={highlighted ? { background: 'rgb(30 45 60 / 0.08)' } : undefined}
                  >
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                      {c.name}
                    </span>
                    <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted)' }}>
                      {c.gameCount} title{c.gameCount === 1 ? '' : 's'}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
