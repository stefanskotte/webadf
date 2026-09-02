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
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const query = q.trim();
    // Clearing the field back to empty is handled synchronously in the
    // onChange handler below, not here -- setting state directly in an
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
        if (!res.ok) {
          setError('Search is unavailable');
          return;
        }
        const body = (await res.json()) as SearchResults;
        // Belt and braces over the abort: aborting is not instantaneous, and
        // a response for an older query can still land after a newer one.
        // Compare against the CURRENT input and drop anything that no
        // longer matches.
        if (controller.signal.aborted) return;
        setResults(body);
        setHighlight(0); // Enter right after typing always opens the top row
        setError(null);
      } catch (e) {
        // An abort is the normal path here, not a failure -- never surface it.
        if ((e as Error).name !== 'AbortError') setError('Could not reach the server');
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

  const flat: Array<
    | { kind: 'title'; item: SearchTitle }
    | { kind: 'collection'; item: SearchCollectionHit }
  > = [
    ...results.titles.map((item) => ({ kind: 'title' as const, item })),
    ...results.collections.map((item) => ({ kind: 'collection' as const, item })),
  ];

  const trimmed = q.trim();
  const showPanel = trimmed !== '';
  const showEmpty = showPanel && flat.length === 0 && !error;

  function onChange(value: string) {
    setQ(value);
    if (value.trim() === '') {
      // Nothing left to search for. Abort whatever was in flight and clear
      // the panel right away, rather than waiting on the debounce -- an
      // empty query renders no panel at all (a different thing from an
      // empty result set), so stale rows must not linger under it.
      abortRef.current?.abort();
      setResults(EMPTY_RESULTS);
      setError(null);
    }
  }

  function select(entry: (typeof flat)[number]) {
    if (entry.kind === 'title') router.push(`/games/${entry.item.id}`);
    else router.push(`/library?collection=${entry.item.id}`);
    setQ('');
    setResults(EMPTY_RESULTS);
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
      setQ('');
      setResults(EMPTY_RESULTS);
      setError(null);
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
        // The panel floats over the page gradient, so --glass-strong (0.80),
        // not --glass (0.62): at 0.62 over --grad-top the --ink rows fall
        // under AA. e2e/contrast.spec.ts measures exactly this class of
        // mistake.
        <div
          data-testid="search-panel"
          className="absolute right-0 top-[42px] z-50 w-80 rounded-xl border p-1.5"
          style={{
            background: 'var(--glass-strong)',
            borderColor: 'var(--hairline-strong)',
            boxShadow: 'var(--shadow-card)',
            backdropFilter: 'blur(12px)',
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
