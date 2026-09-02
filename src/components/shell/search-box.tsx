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
import { useRouter } from 'next/navigation';

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
  const router = useRouter();
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

  // Every path that empties the box or dismisses the panel funnels through
  // here, so abort/clear/reset-highlight can never be forgotten on one of
  // them. Missing this on even one path (Escape, select(), or clearing the
  // input) leaves a stale request free to land later and repopulate a panel
  // the user believes is closed, or worse, an open one for a different query.
  function reset() {
    abortRef.current?.abort();
    currentQueryRef.current = '';
    setQ('');
    setResults(EMPTY_RESULTS);
    setRespondedQuery(null);
    setError(null);
    setHighlight(0);
  }

  useEffect(() => {
    const query = q.trim();
    // Clearing the field back to empty is handled synchronously by reset(),
    // not here -- setting state directly in an effect body (rather than
    // inside the async callback below) is exactly the pattern
    // react-hooks/set-state-in-effect flags, and there is nothing to
    // synchronize with an external system for "the box is empty".
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

  const trimmed = q.trim();
  const showPanel = trimmed !== '';
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
  const showEmpty = showPanel && !error && respondedQuery === trimmed && flat.length === 0;

  function onChange(value: string) {
    const trimmedValue = value.trim();
    if (trimmedValue === '') {
      // Nothing left to search for. reset() aborts whatever was in flight
      // and clears the panel right away, rather than waiting on the
      // debounce -- an empty query renders no panel at all (a different
      // thing from an empty result set), so stale rows must not linger
      // under it.
      reset();
      return;
    }
    setQ(value);
    currentQueryRef.current = trimmedValue;
  }

  function select(entry: (typeof flat)[number]) {
    if (entry.kind === 'title') router.push(`/games/${entry.item.id}`);
    else router.push(`/library?collection=${entry.item.id}`);
    // SearchBox lives in the layout, so router.push does not unmount it --
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
    <div className="relative">
      <input
        ref={inputRef}
        data-testid="search-input"
        placeholder="Search titles"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="h-[34px] w-56 rounded-full border px-4 text-[13px] outline-none transition-colors"
        style={{
          background: 'rgb(255 255 255 / 0.12)',
          borderColor: 'rgb(255 255 255 / 0.16)',
          color: 'var(--on-dark)',
        }}
      />

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
        // --muted-2 5.11:1, --faint 4.74:1 -- all clear 4.5:1.
        <div
          data-testid="search-panel"
          className="absolute right-0 top-[42px] z-50 w-80 rounded-xl border p-1.5"
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
                    <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
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
                    <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
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
