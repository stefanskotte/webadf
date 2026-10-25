'use client';

// The typeahead box in both shells' headers. Fires on every keystroke
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
import { SearchIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';
import { DiskIcon } from '@/components/ui/disk-icon';
import { matchHelpTopics } from '@/lib/help/match';
import { HELP_TOPICS, type HelpTopicId } from '@/lib/help/topics';
import { titleDiskColor } from '@/lib/library-look';
import { searchEmptyText, searchTitleSub } from '@/lib/search-look';

interface SearchTitle {
  id: string;
  title: string;
  year: number | null;
  publisher: string | null;
  diskCount: number;
  collections: string[];
  // Optional on the client: a page loaded before a deploy may meet an older server for one request.
  authored?: boolean; hasHd?: boolean; hasHfe?: boolean; kind?: string | null;
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

type Entry =
  | { kind: 'title'; item: SearchTitle }
  | { kind: 'collection'; item: SearchCollectionHit }
  | { kind: 'help'; item: { id: HelpTopicId } };

/** Where a row goes: the same three destinations as before (Ruling 23 makes them real links). */
function hrefOf(e: Entry): string {
  if (e.kind === 'title') return `/games/${e.item.id}`;
  if (e.kind === 'help') return `/help#${e.item.id}`;
  return `/library?collection=${e.item.id}`;
}

const GROUP_LABEL = { title: 'Titles', collection: 'Collections', help: 'Help' } as const;

function LetterTile({ letter }: { letter: string }) {
  return (
    <span data-tile className="flex size-[30px] items-center justify-center rounded-[8px] font-mono text-[12px] font-semibold"
          style={{ background: 'var(--track)', color: 'var(--muted)' }}>{letter}</span>
  );
}

/** A row's icon, name and sub line (spec §5.4). */
function rowParts(e: Entry): { id: string; name: string; sub: string; clamp: boolean; icon: React.ReactNode } {
  if (e.kind === 'title') {
    const t = e.item;
    const color = titleDiskColor({ id: t.id, hasHd: !!t.hasHd, hasHfe: !!t.hasHfe, kind: t.kind, authored: !!t.authored });
    return {
      id: t.id, name: t.title, sub: searchTitleSub(t), clamp: false,
      icon: <span data-disk-color={color}><DiskIcon size={30} color={color} hd={!!t.hasHd} stack={t.diskCount} mounted={false} /></span>,
    };
  }
  if (e.kind === 'collection') {
    const c = e.item;
    return { id: c.id, name: c.name, sub: `${c.gameCount} title${c.gameCount === 1 ? '' : 's'}`, clamp: false, icon: <LetterTile letter="C" /> };
  }
  const h = HELP_TOPICS[e.item.id];
  return { id: e.item.id, name: h.title, sub: h.short, clamp: true, icon: <LetterTile letter="?" /> };
}

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
  const [open, setOpen] = useState(false);   // Ruling 22: cleared on blur and by the scrim; the query stays

  const trimmed = q.trim();
  // While an error is showing, the rows behind it are stale and must not be
  // navigable -- an empty flat list here also disarms ArrowUp/ArrowDown/Enter.
  const flat: Entry[] = error
    ? []
    : [
        ...results.titles.map((item) => ({ kind: 'title' as const, item })),
        ...results.collections.map((item) => ({ kind: 'collection' as const, item })),
        // Help topics (A3), matched here in the browser: they ship with the app, so no request is needed.
        ...matchHelpTopics(trimmed).map((id) => ({ kind: 'help' as const, item: { id } })),
      ];
  const showEmpty = trimmed !== '' && !error && respondedQuery === trimmed && flat.length === 0;
  // The panel itself is gated on there being something to put in it. Without
  // this, the bordered box renders empty (no rows, no error, no empty-state
  // line yet -- respondedQuery hasn't caught up) for the whole debounce plus
  // round trip of every single search: a small blank box flashing under the
  // pill on the first keystroke.
  const showPanel = trimmed !== '' && (error !== null || flat.length > 0 || showEmpty);
  const panelOpen = open && showPanel;

  // Ruling 26: the list scrolls past 620 px, so the arrows keep the highlighted option in view.
  useEffect(() => {
    if (!panelOpen) return;
    document.getElementById(`search-opt-${highlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight, panelOpen]);

  function onChange(value: string) {
    setOpen(true);
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

  function select(entry: Entry) {
    // The page's loading placeholders (loading.tsx) confirm the press landed.
    router.push(hrefOf(entry));
    // SearchBox lives in the layout, so navigating does not unmount it -- without reset() here the request for
    // whatever was typed keeps running and can repopulate the panel with the PREVIOUS search's rows the next time it
    // opens.
    reset();
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      if (flat.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % flat.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (flat.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === 'Enter') {
      const entry = panelOpen ? flat[highlight] : undefined;
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

  const groups = (['title', 'collection', 'help'] as const)
    .map((kind) => ({ kind, rows: flat.map((entry, index) => ({ entry, index })).filter((r) => r.entry.kind === kind) }))
    .filter((g) => g.rows.length > 0);

  return (
    // Static, so the panel anchors to the header (both shells' headers are `relative`); see the plan ruling in C5
    // Task 5. Full width below sm, where the header wraps the box onto a line it shares with the icon buttons; mr-2
    // keeps it 16px clear of them (they sit 8px apart).
    <div className="mr-2 w-full sm:w-auto">
      <div className="relative w-full sm:w-auto">
        <SearchIcon aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
                    style={{ color: 'var(--muted-2)' }} />
        <input
          ref={inputRef}
          data-testid="search-input"
          // LiveRefresh's typing() guard skips this box (src/components/shell/live-refresh.tsx): it lives in the
          // layout, and focus lingering here must not hold back live updates the way a rename field should.
          data-live-ok
          role="combobox"
          aria-expanded={panelOpen}
          aria-controls="search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={panelOpen && flat.length > 0 ? `search-opt-${highlight}` : undefined}
          aria-label="Search titles"
          title="Search titles — press / to focus"
          placeholder="Search titles"
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); if (q.trim() !== '') setOpen(true); }}
          onBlur={() => { setFocused(false); setOpen(false); }}
          // w-48 (not w-56): at w-56 the admin shell's centred pill and this input overlapped by 15px at 1280. The
          // focus ring is a box-shadow in the full --ring (>= 3:1 on the bar, WCAG 1.4.11).
          className="h-10 w-full rounded-[10px] border pl-9 pr-4 text-[14px] outline-none transition-colors placeholder:text-(--muted-2) focus-visible:ring-2 focus-visible:ring-(--ring) sm:w-48 sm:pr-9"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--ink)' }}
        />
        {/* The "/" shortcut, advertised while the box is idle (aria-hidden: the title attribute says it). Hidden below
            sm: a phone has no key to press. */}
        {!focused && q === '' && (
          <kbd aria-hidden data-testid="search-hint"
               className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border px-1.5 font-mono text-[11px] leading-[15px] sm:block"
               style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
            /
          </kbd>
        )}
      </div>

      {panelOpen && (
        // A light scrim from sm (spec §5.3). Not a focus trap: this is a combobox popup, not a dialog. A press on it
        // also blurs the input, which closes the panel on its own; the handler makes the close not depend on that.
        <div data-testid="search-scrim" aria-hidden onPointerDown={() => setOpen(false)}
             className="fixed inset-x-0 bottom-0 top-[72px] z-40 hidden sm:block" style={{ background: 'var(--search-scrim)' }} />
      )}

      {panelOpen && (
        <div
          data-testid="search-panel"
          // No press inside the panel may blur the input (Ruling 22): the row would vanish under the pointer.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-4 right-4 top-[calc(100%+4px)] z-50 flex flex-col overflow-hidden rounded-[16px] border sm:left-auto sm:right-7 sm:top-[64px] sm:w-[min(600px,calc(100vw-56px))]"
          style={{ background: 'var(--surface)', borderColor: 'var(--line)', boxShadow: 'var(--shadow-card)' }}
        >
          {error ? (
            <div data-testid="search-error" className="px-[18px] py-4 text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</div>
          ) : showEmpty ? (
            <div data-testid="search-empty" className="px-[18px] py-4 text-[13px]" style={{ color: 'var(--muted)' }}>
              {searchEmptyText(trimmed)}
            </div>
          ) : (
            <div role="listbox" id="search-listbox" aria-label="Search results"
                 className="max-h-[min(620px,calc(100dvh-160px))] overflow-y-auto p-2">
              {groups.map((g) => (
                <div key={g.kind} role="group" aria-labelledby={`search-group-${g.kind}`}>
                  <div id={`search-group-${g.kind}`} data-testid={`search-group-${g.kind}`}
                       className="px-2.5 pb-1 pt-2.5 text-[12px] font-medium" style={{ color: 'var(--muted-2)' }}>
                    {GROUP_LABEL[g.kind]}
                  </div>
                  {g.rows.map(({ entry, index }) => {
                    const p = rowParts(entry);
                    const highlighted = index === highlight;
                    return (
                      <Link key={`${entry.kind}-${p.id}`} href={hrefOf(entry)} role="option" id={`search-opt-${index}`}
                            aria-selected={highlighted} tabIndex={-1}
                            data-testid="search-result" data-result-kind={entry.kind} data-result-id={p.id}
                            onMouseEnter={() => setHighlight(index)}
                            onClick={() => { reset(); inputRef.current?.blur(); }}
                            className="flex min-h-[50px] items-center gap-3 rounded-[10px] px-2.5 py-1.5"
                            style={highlighted ? { background: 'var(--surface-2)' } : undefined}>
                        <span aria-hidden className="flex size-[30px] shrink-0 items-center justify-center">{p.icon}</span>
                        <span className="flex min-w-0 flex-1 flex-col gap-px">
                          <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{p.name}</span>
                          {/* --muted, not --muted-2: 6.71:1 on the highlighted row's --surface-2. */}
                          <span data-testid="search-result-sub" className={`text-[12px]${p.clamp ? ' line-clamp-2' : ''}`}
                                style={{ color: 'var(--muted)' }}>{p.sub}</span>
                        </span>
                        {highlighted && (
                          <kbd aria-hidden className="hidden rounded-[6px] border px-[7px] font-mono text-[12px] sm:block"
                               style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>↵</kbd>
                        )}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <div data-testid="search-keys"
               className="hidden min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-[12px] sm:flex"
               style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
            {([['↑ ↓', 'to move'], ['↵', 'to open'], ['Esc', 'to close'], ['/', 'from anywhere']] as const).map(([k, w]) => (
              <span key={k}><kbd className="font-mono">{k}</kbd> {w}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
