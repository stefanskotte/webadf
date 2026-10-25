'use client';

import { useEffect, useRef, useState } from 'react';
import { Link } from '@/components/shell/link';
import { currentSection, sectionForHash } from '@/lib/side-nav';

export type SideNavItem = { href: string; label: string; focusId?: string; tone?: 'danger' };
export type SideNavGroup = { label?: string; testId?: string; items: SideNavItem[] };

const ITEM =
  'flex w-full items-center px-3 text-left text-[14px] hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
/** After a click the browser's jump fires scroll events; they must not re-mark the section (the last card cannot reach the top). */
const CLICK_LOCK_MS = 600;

/**
 * The section list Settings and Help have on their boards (C5 spec §1.2). "Current" is the section in view: an
 * IntersectionObserver over the in-page targets marks the topmost one in the top 40 % of the viewport; before any
 * scroll, the hash target, else the first. A route item (`/about`) is never current. A click lets the browser jump,
 * then focuses the target's heading so the keyboard continues from there.
 */
export function SideNav({ label, testId, groups, size = 'md' }: {
  label: string; testId: string; groups: SideNavGroup[]; size?: 'md' | 'sm';
}) {
  const ids = groups.flatMap((g) => g.items).filter((i) => i.href.startsWith('#')).map((i) => i.href.slice(1));
  const key = ids.join(' ');
  const [current, setCurrent] = useState<string | null>(null);
  const lockUntil = useRef(0);
  const arrived = useRef(false);
  // Kept across effect runs (a re-run -- React's dev double run, a filter changing the ids -- must not end it early).
  const arrivalUntil = useRef(0);

  useEffect(() => {
    const list = key ? key.split(' ') : [];
    if (list.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    let scrolled = false;
    // A full load of a #section link: the sections stream in behind the app's loading screen, so the browser's own
    // jump can run before they exist and is not retried. Jump once here; the scrolls of that jump are not the reader's,
    // so for CLICK_LOCK_MS the mark keeps following the hash.
    if (!arrived.current) {
      arrived.current = true;
      const target = sectionForHash(list, window.location.hash);
      if (target) {
        arrivalUntil.current = performance.now() + CLICK_LOCK_MS;
        document.getElementById(target)?.scrollIntoView();
      }
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      if (performance.now() < lockUntil.current) return;
      const next = currentSection(list, scrolled ? visible : null, window.location.hash);
      if (next) setCurrent(next);
    }, { rootMargin: '0px 0px -60% 0px' });
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    const onScroll = () => { if (performance.now() >= arrivalUntil.current) scrolled = true; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { io.disconnect(); window.removeEventListener('scroll', onScroll); };
  }, [key]);

  // Back and Forward change the hash without a click: the mark follows the URL.
  useEffect(() => {
    const list = key ? key.split(' ') : [];
    const onHash = () => {
      const next = sectionForHash(list, window.location.hash);
      if (next) { lockUntil.current = performance.now() + CLICK_LOCK_MS; setCurrent(next); }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [key]);

  const shown = current ?? ids[0] ?? null;
  const height = size === 'sm' ? 'min-h-[34px] rounded-[9px] py-1.5' : 'min-h-[38px] rounded-[10px] py-2';

  return (
    <nav aria-label={label} data-testid={testId} className="flex flex-col gap-0.5">
      {groups.map((g, gi) => (
        <div key={g.label ?? gi} data-testid={g.testId} className="flex flex-col gap-0.5">
          {g.label && (
            <span className="px-3 pb-1 pt-2.5 text-[12px] font-medium" style={{ color: 'var(--muted-2)' }}>{g.label}</span>
          )}
          {g.items.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => {
                const inPage = it.href.startsWith('#');
                const isCurrent = inPage && it.href.slice(1) === shown;
                const style = {
                  background: isCurrent ? 'var(--surface)' : undefined,
                  boxShadow: isCurrent ? '0 0 0 1px var(--line)' : undefined,
                  color: it.tone === 'danger' ? 'var(--danger-fg)'
                    : isCurrent || size === 'sm' ? 'var(--ink)' : 'var(--muted)',
                  overflowWrap: 'anywhere' as const,
                };
                const cls = `${ITEM} ${height} ${isCurrent ? 'font-semibold' : 'font-medium'}`;
                return (
                  <li key={it.href}>
                    {inPage ? (
                      <a href={it.href} aria-current={isCurrent ? 'true' : undefined} className={cls} style={style}
                         onClick={() => {
                           const id = it.href.slice(1);
                           lockUntil.current = performance.now() + CLICK_LOCK_MS;
                           setCurrent(id);
                           requestAnimationFrame(() =>
                             document.getElementById(it.focusId ?? id)?.focus({ preventScroll: true }));
                         }}>
                        {it.label}
                      </a>
                    ) : (
                      <Link href={it.href} className={cls} style={style}>{it.label}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}
