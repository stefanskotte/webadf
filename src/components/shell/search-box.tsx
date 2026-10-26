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
import { flushSync } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
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
  const openerRef = useRef<HTMLButtonElement>(null);
  // Below sm the field lives behind the search-open button and opens as a row over the header (C7 spec §2.4, Ruling 6);
  // from sm it always shows, as before. The max-sm: classes below read this state, so it is inert from sm.
  const [phoneOpen, setPhoneOpen] = useState(false);
  // A route change closes the row (adjusting state during render, not in an effect).
  const pathname = usePathname();
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (phoneOpen) setPhoneOpen(false);
  }

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

  /** Below sm (the opener's width): read when a key or a choice decides where focus goes. */
  const isPhone = () => window.matchMedia('(max-width: 639.98px)').matches;

  // flushSync: the field must be displayed before focus() runs, inside the tap's own gesture -- iOS raises the
  // keyboard only for a focus made there.
  function openPhone() {
    flushSync(() => setPhoneOpen(true));
    inputRef.current?.focus();
  }

  /** Close the phone row and hand focus to the opener: the field just went, and focus must not fall to <body>. */
  function closePhone() {
    flushSync(() => setPhoneOpen(false));
    openerRef.current?.focus();
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

  // Crossing the sm line: widening closes the phone row (the field is always shown from sm); narrowing while the
  // desktop field has focus hands focus to the opener, because the field is about to be hidden.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639.98px)');
    function onChange(e: MediaQueryListEvent) {
      if (e.matches) {
        if (document.activeElement === inputRef.current) openerRef.current?.focus();
      } else {
        setPhoneOpen(false);
      }
    }
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Global shortcuts: Cmd/Ctrl+K always focuses; `/` focuses UNLESS focus is
  // already inside another input, textarea or contenteditable -- otherwise
  // this steals the key from the collection rename field and the
  // create-collection input on /library. Below sm either one opens the row first.
  useEffect(() => {
    function focusField() {
      if (window.matchMedia('(max-width: 639.98px)').matches) flushSync(() => setPhoneOpen(true));
      inputRef.current?.focus();
    }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusField();
        return;
      }
      if (e.key === '/') {
        const active = document.activeElement;
        const tag = active?.tagName;
        const isEditable =
          tag === 'INPUT' || tag === 'TEXTAREA' || (active as HTMLElement | null)?.isContentEditable;
        if (isEditable) return;
        e.preventDefault();
        focusField();
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
  // The listbox exists only when rows are shown: not under the error or the empty line.
  const listboxShown = panelOpen && !error && !showEmpty && flat.length > 0;
  // Help rows are matched live, ahead of the server's answer, so the list can shrink under the highlight.
  const active = Math.min(highlight, Math.max(flat.length - 1, 0));
  // Only keyboard moves scroll the highlighted row into view; a hover must not make the list jump.
  const scrollOnMove = useRef(false);

  // Ruling 26: the list scrolls past 620 px, so the arrows keep the highlighted option in view.
  useEffect(() => {
    if (!panelOpen || !scrollOnMove.current) return;
    scrollOnMove.current = false;
    document.getElementById(`search-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, panelOpen]);

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
    // Below sm the row closes and focus goes to the opener (Plan ruling, C7 Task 3); from sm, as before.
    if (phoneOpen && isPhone()) closePhone();
    else inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // An IME composition owns its keys; and a modified arrow or Enter belongs to the browser (house listbox convention).
    if (e.nativeEvent.isComposing) return;
    const modified = e.altKey || e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowDown' && !modified) {
      if (flat.length === 0) return;
      e.preventDefault();
      setOpen(true);
      scrollOnMove.current = true;
      setHighlight((h) => (Math.min(h, flat.length - 1) + 1) % flat.length);
      return;
    }
    if (e.key === 'ArrowUp' && !modified) {
      if (flat.length === 0) return;
      e.preventDefault();
      setOpen(true);
      scrollOnMove.current = true;
      setHighlight((h) => (Math.min(h, flat.length - 1) - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === 'Enter' && !modified) {
      const entry = panelOpen ? flat[active] : undefined;
      if (entry) {
        e.preventDefault();
        select(entry);
      }
      return;
    }
    if (e.key === 'Escape') {
      reset();
      if (phoneOpen && isPhone()) closePhone();
      else inputRef.current?.blur();
    }
  }

  const groups = (['title', 'collection', 'help'] as const)
    .map((kind) => ({ kind, rows: flat.map((entry, index) => ({ entry, index })).filter((r) => r.entry.kind === kind) }))
    .filter((g) => g.rows.length > 0);

  return (
    // Static, so the panel anchors to the header (both shells' headers are `relative`); see the plan ruling in C5
    // Task 5. lg:mr-2 keeps the field 16 px clear of the gear group (they sit 8 px apart).
    <div className="lg:mr-2">
      {/* Below sm: a 44 px button that opens the row (C7 spec §2.4). Hidden while the row is open and from sm. */}
      <button ref={openerRef} type="button" data-testid="search-open" aria-label="Search" aria-expanded={phoneOpen}
              aria-controls="search-row" onClick={openPhone}
              className={`${phoneOpen ? 'hidden' : 'flex'} size-11 items-center justify-center rounded-[10px] text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) sm:hidden`}>
        <SearchIcon aria-hidden className="size-5" />
      </button>
      {/* Below sm, while open, the row covers the header's 60 px row: the field, then Cancel. From sm it is a plain
          block holding the field, as before. */}
      <div id="search-row"
           className={phoneOpen
             ? 'max-sm:absolute max-sm:inset-0 max-sm:z-50 max-sm:flex max-sm:items-center max-sm:gap-2.5 max-sm:bg-(--surface) max-sm:px-4'
             : 'max-sm:hidden'}>
        <div className="relative max-sm:min-w-0 max-sm:flex-1">
          <SearchIcon aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
                      style={{ color: 'var(--muted-2)' }} />
          <input
            ref={inputRef}
            data-testid="search-input"
            // LiveRefresh's typing() guard skips this box (src/components/shell/live-refresh.tsx): it lives in the
            // layout, and focus lingering here must not hold back live updates the way a rename field should.
            data-live-ok
            role="combobox"
            aria-expanded={listboxShown}
            aria-controls={listboxShown ? 'search-listbox' : undefined}
            aria-autocomplete="list"
            aria-activedescendant={listboxShown ? `search-opt-${active}` : undefined}
            aria-label="Search titles"
            title="Search titles — press / to focus"
            placeholder="Search titles"
            value={q}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => { setFocused(true); if (q.trim() !== '') setOpen(true); }}
            onBlur={() => {
              setFocused(false);
              setOpen(false);
              // The viewport shrank below sm under a focused desktop field: it is now display:none, and focus would
              // fall to <body>. (The matchMedia listener below covers the engines that fire it first.)
              const el = inputRef.current;
              if (el && !phoneOpen && el.getClientRects().length === 0 && window.matchMedia('(max-width: 639.98px)').matches) {
                openerRef.current?.focus();
              }
            }}
            // w-48 (not w-56) from sm: at w-56 the admin shell's centred pill and this input overlapped by 15px at
            // 1280. 44 px tall below sm (a finger). The focus ring is a box-shadow in the full --ring (>= 3:1, WCAG
            // 1.4.11).
            className="h-11 w-full rounded-[10px] border pl-9 pr-4 text-[14px] outline-none transition-colors placeholder:text-(--muted-2) focus-visible:ring-2 focus-visible:ring-(--ring) sm:h-10 sm:w-48 sm:pr-9"
            style={{ background: 'var(--surface-2)', borderColor: 'var(--line)', color: 'var(--ink)' }}
          />
          {/* The "/" shortcut, advertised while the box is idle (aria-hidden: the title attribute says it). Hidden
              below sm: a phone has no key to press. */}
          {!focused && q === '' && (
            <kbd aria-hidden data-testid="search-hint"
                 className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border px-1.5 font-mono text-[11px] leading-[15px] sm:block"
                 style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
              /
            </kbd>
          )}
        </div>
        {/* Today's Escape, for a thumb: clears, closes the row, focus back on the opener. */}
        <button type="button" data-testid="search-cancel" onClick={() => { reset(); closePhone(); }}
                className="h-11 shrink-0 rounded-[10px] px-3 text-[14px] font-semibold text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) sm:hidden">
          Cancel
        </button>
      </div>

      {panelOpen && (
        // From sm a light scrim (C5 spec §5.3); below sm the same scrim, colourless, so a tap outside the panel
        // closes it (C7 Ruling 7: iOS's tap-away did not blur). Not a focus trap: this is a combobox popup.
        // Below sm it closes on click, not pointerdown: the scrim must still be the click target when the touch's
        // synthesized click arrives, or the click falls through to the link underneath. mousedown is cancelled there so
        // the input does not blur (and unmount the scrim) first. z-30: under the tab bar (z-40), so a tab still takes
        // its first tap. From sm, pointerdown closes as in C5.
        <div data-testid="search-scrim" aria-hidden
             onPointerDown={() => { if (!isPhone()) setOpen(false); }}
             onMouseDown={(e) => { if (isPhone()) e.preventDefault(); }}
             onClick={() => setOpen(false)}
             className="fixed inset-x-0 bottom-0 top-[60px] z-30 bg-transparent sm:z-40 sm:bg-(--search-scrim) lg:top-[72px]" />
      )}

      {panelOpen && (
        <div
          data-testid="search-panel"
          // No press inside the panel may blur the input (Ruling 22): the row would vanish under the pointer.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-4 right-4 top-[calc(100%+4px)] z-50 flex flex-col overflow-hidden rounded-[16px] border sm:left-auto sm:w-[min(600px,calc(100vw-32px))] lg:right-7 lg:top-[64px] lg:w-[min(600px,calc(100vw-56px))]"
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
                    const highlighted = index === active;
                    return (
                      <Link key={`${entry.kind}-${p.id}`} href={hrefOf(entry)} role="option" id={`search-opt-${index}`}
                            aria-selected={highlighted} tabIndex={-1}
                            data-testid="search-result" data-result-kind={entry.kind} data-result-id={p.id}
                            onMouseEnter={() => setHighlight(index)}
                            onClick={() => { reset(); if (phoneOpen && isPhone()) closePhone(); else inputRef.current?.blur(); }}
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
