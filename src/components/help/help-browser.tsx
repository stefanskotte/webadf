'use client';

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SearchIcon } from 'lucide-react';
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query';
import { PageHeader } from '@/components/shell/page-header';
import { SideNav, type SideNavGroup } from '@/components/shell/side-nav';
import { HELP_GROUPS, HELP_ORDER, HELP_TOPICS, helpGroupOf, type HelpTopicId } from '@/lib/help/topics';
import { filterHelpTopics } from '@/lib/help/match';

const noopSubscribe = () => () => {};
const TOTAL = HELP_ORDER.length;
const CARD = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
/** The board's article look on the seventeen bodies, applied from the wrapper -- the bodies themselves are not edited. */
const PROSE = [
  'flex max-w-[68ch] flex-col gap-3 text-[15px] leading-[1.6]',
  '[&_strong]:font-semibold [&_strong]:text-(--ink)',
  '[&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2.5 [&_ul]:pl-[22px] [&_ol]:flex [&_ol]:flex-col [&_ol]:gap-2.5 [&_ol]:pl-[22px]',
  '[&_a]:font-semibold [&_a]:text-(--amber-text) [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-(--ink)',
  '[&_code]:font-mono [&_code]:text-[14px]',
].join(' ');

/**
 * The Help page (C5 spec §3; board InfHelp): every topic on the one page as an article card (Ruling 12), a grouped
 * topic list sticky from lg (Ruling 13), and the board's "Search help" filter (Ruling 15). Below lg the filter and a
 * closed "Topics · 17" disclosure sit above the articles; the nav inside it is the same single nav.
 */
export function HelpBrowser() {
  const [q, setQ] = useState('');
  // Open on the server and on the hydrating render (no mismatch, and a usable list without JS on desktop); a phone
  // closes it right after hydration, until the reader opens or closes it themselves.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [navPick, setNavPick] = useState<boolean | null>(null);
  const lg = useMediaQuery('(min-width: 1024px)', {});
  const navOpen = navPick ?? !hydrated;
  // C7 (spec §9.2, Ruling 26): on a phone the Topics list closes right after hydration, and the articles move up under
  // a reader who loaded /help#topic. Put the topic back at the top in the same frame, once.
  const jumped = useRef(false);
  useLayoutEffect(() => {
    if (jumped.current || !hydrated || lg || navPick !== null) return;
    jumped.current = true;
    const id = window.location.hash.slice(1);
    if (id && id in HELP_TOPICS) document.getElementById(id)?.scrollIntoView();
  }, [hydrated, lg, navPick]);
  const f = filterHelpTopics(q);
  const shown = (id: HelpTopicId) => !f.active || f.ids.has(id);
  const none = f.active && f.ids.size === 0;

  const groups: SideNavGroup[] = HELP_GROUPS
    .filter((g) => none || g.topics.some(shown))
    .map((g) => ({
      label: g.name,
      testId: `help-group-${g.id}`,
      items: none ? [] : g.topics.filter(shown).map((id) => ({ href: `#${id}`, label: HELP_TOPICS[id].title, focusId: `help-h-${id}` })),
    }));

  return (
    <div className="px-4 pb-10 pt-6 sm:px-7 lg:grid lg:grid-cols-[260px_minmax(0,720px)] lg:items-start lg:gap-8">
      <aside className="mb-5 flex flex-col lg:sticky lg:top-6 lg:mb-0 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto">
        <div className="mb-2 flex flex-col gap-1">
          <label className="flex h-[38px] max-sm:min-h-11 items-center gap-2 rounded-[10px] border px-2.5 focus-within:ring-2 focus-within:ring-(--ring)"
                 style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
            <SearchIcon aria-hidden className="size-3.5 shrink-0" style={{ color: 'var(--muted-2)' }} />
            <input type="search" data-testid="help-filter" aria-label="Search help" placeholder="Search help"
                   aria-controls="help-articles" value={q} onChange={(e) => setQ(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setQ(''); } }}
                   className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-(--muted-2)"
                   style={{ color: 'var(--ink)' }} />
          </label>
          <span role="status" data-testid="help-filter-count" className="px-1 text-[12px]" style={{ color: 'var(--muted-2)' }}>
            {f.active ? `${f.ids.size} of ${TOTAL} topics` : ''}
          </span>
        </div>
        <details open={lg || navOpen} onToggle={(e) => { if (!lg) setNavPick(e.currentTarget.open); }}
                 onClick={(e) => { if (!lg && (e.target as HTMLElement).closest('nav a')) setNavPick(false); }}>
          <summary data-testid="help-nav-toggle" className="flex h-10 max-sm:min-h-11 cursor-pointer items-center px-1 text-[14px] font-semibold lg:hidden"
                   style={{ color: 'var(--ink)' }}>
            {f.active ? `Topics · ${f.ids.size} of ${TOTAL}` : `Topics · ${TOTAL}`}
          </summary>
          <SideNav label="Help topics" testId="help-nav" groups={groups} size="sm" />
        </details>
      </aside>
      <div className="flex min-w-0 flex-col gap-5">
        <PageHeader flush size="lg" title="Help" subtitle="What the less obvious parts of WebFloppy do, and why." />
        <div id="help-articles" className="flex flex-col gap-5">
          {none && (
            <p data-testid="help-filter-empty" className="text-[13px]" style={{ color: 'var(--muted)' }}>
              No topic matches “{q.trim()}”. Clear the search to see all {TOTAL}.
            </p>
          )}
          {HELP_ORDER.map((id) => {
            const t = HELP_TOPICS[id];
            return (
              // `hidden` (display:none), not the attribute: the card's own `flex` would override [hidden].
              <article key={id} id={id} data-testid={`help-section-${id}`} aria-labelledby={`help-h-${id}`}
                       className={`${shown(id) ? 'flex' : 'hidden'} scroll-mt-6 flex-col gap-4 rounded-[20px] p-5 sm:p-8`} style={CARD}>
                <span className="text-[13px] font-medium" style={{ color: 'var(--muted-2)' }}>Help · {helpGroupOf(id).name}</span>
                <h2 id={`help-h-${id}`} tabIndex={-1}
                    className="rounded-[6px] text-[24px] font-bold leading-[1.05] tracking-[-0.02em] focus:outline-2 focus:outline-offset-2 focus:outline-(--ring) sm:text-[30px]"
                    style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)', overflowWrap: 'anywhere' }}>
                  {t.title}
                </h2>
                <div className={PROSE} style={{ color: 'var(--prose)' }}>{t.body}</div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
