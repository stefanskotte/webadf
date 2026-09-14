'use client';

/* eslint-disable @next/next/no-img-element */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ProductionLite } from '@/components/games/demozoo-actions';

export interface ReviewItemLite {
  gameId: string; gameTitle: string;
  suggestions: Array<{
    production: ProductionLite; sources: string[];
    // R18 (spec §8): which of this org's disks produced this suggestion.
    disks: Array<{ diskNo: number; filename: string | null }>;
  }>;
}

const byline = (p: ProductionLite) => [p.groups.join(', '), p.releaseYear, p.types.join(', ')].filter(Boolean).join(' · ');

const diskLine = (disks: ReviewItemLite['suggestions'][number]['disks']) =>
  `from ${disks.map((d) => `disk ${d.diskNo}${d.filename ? ` · ${d.filename}` : ''}`).join(', ')}`;

// R17: at most this many items per accept request (the API caps at 100 --
// see src/app/api/demozoo/accept/route.ts -- this stays comfortably under it).
const ACCEPT_CHUNK_SIZE = 50;

export function DemozooReview({ items }: { items: ReviewItemLite[] }) {
  const router = useRouter();
  // R18 (fix round 1): state holds only EXPLICIT user overrides, never the
  // full pick map. `router.refresh()` (after Accept or "Not this") re-renders
  // this component with a new `items` prop, and the old plain `useState`
  // lazy-initializer never re-ran for it -- a vanished game's stale pick
  // stayed selected (and could be resent on a later Accept, even a
  // just-dismissed pair), and a newly single-candidate row never got its
  // free pre-tick. Deriving `picked` fresh from `items` + `overrides` on
  // every render fixes both: a game not in the current `items` contributes
  // nothing to `picked` at all, and an override naming a production the
  // item no longer offers (dismissed away) falls back to the default.
  // null = an explicit "skip this title" override.
  const [overrides, setOverrides] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);

  if (items.length === 0) {
    return <p className="px-4 text-[13px] sm:px-7" style={{ color: 'var(--on-dark-muted)' }} data-testid="review-empty">Nothing to review.</p>;
  }

  // Single-candidate rows default to ticked; multi-candidate rows default to
  // unpicked (operator ruling) -- UNLESS an override exists and still names
  // one of this item's current suggestions (or is an explicit skip).
  const picked: Record<string, number | null> = Object.fromEntries(items.map((item) => {
    if (item.gameId in overrides) {
      const o = overrides[item.gameId];
      if (o === null || item.suggestions.some((s) => s.production.id === o)) return [item.gameId, o];
    }
    return [item.gameId, item.suggestions.length === 1 ? item.suggestions[0].production.id : null];
  }));
  const selected = Object.entries(picked).filter((e): e is [string, number] => e[1] !== null);

  // R17: the API caps a single request at 100 items, so a large selection is
  // sent as sequential chunks of 50, one request at a time, summing
  // `accepted`. Stop at the first failed chunk -- toast how many were linked
  // before it failed -- and refresh once at the end either way, so the queue
  // reflects whatever did land even on a partial failure.
  async function accept() {
    setBusy(true);
    let accepted = 0;
    let failed = false;
    for (let i = 0; i < selected.length; i += ACCEPT_CHUNK_SIZE) {
      const chunk = selected.slice(i, i + ACCEPT_CHUNK_SIZE);
      try {
        const res = await fetch('/api/demozoo/accept', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: chunk.map(([gameId, productionId]) => ({ gameId, productionId })) }),
        });
        if (!res.ok) { failed = true; break; }
        const json = await res.json();
        accepted += json.accepted;
      } catch { failed = true; break; }
    }
    if (failed) toast.error(`Linked ${accepted} title${accepted === 1 ? '' : 's'} before the request failed`);
    else toast.success(`Linked ${accepted} title${accepted === 1 ? '' : 's'}`);
    router.refresh();
    setBusy(false);
  }

  async function dismiss(gameId: string, productionId: number) {
    try {
      const res = await fetch(`/api/games/${gameId}/demozoo/dismiss`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productionId }),
      });
      if (res.ok) router.refresh(); else toast.error('Could not dismiss that suggestion');
    } catch { toast.error('Could not reach the server'); }
  }

  return (
    <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7" data-testid="demozoo-review">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="review-accept" disabled={busy || selected.length === 0}
          className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--primary-action)' }}
          onClick={accept}>
          Accept selected ({selected.length})
        </button>
      </div>
      {items.map((item) => (
        <div key={item.gameId} className="glass-card p-4" data-testid="review-item" data-game-id={item.gameId}>
          <div className="mb-2 text-[13px] font-semibold">{item.gameTitle}</div>
          <ul className="flex flex-col gap-2">
            {item.suggestions.map(({ production: p, disks }) => {
              const single = item.suggestions.length === 1;
              const checked = picked[item.gameId] === p.id;
              const toggle = () => setOverrides((s) => ({ ...s, [item.gameId]: checked && single ? null : p.id }));
              return (
                <li key={p.id} className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <label className="flex min-w-0 flex-1 items-center gap-3">
                    <input type={single ? 'checkbox' : 'radio'} name={`pick-${item.gameId}`} checked={checked} onChange={toggle}
                      data-testid={single ? 'review-check' : 'review-pick'} data-production-id={p.id} />
                    <span className="h-[54px] w-[70px] shrink-0 overflow-hidden rounded" style={{ background: 'var(--hairline)' }}>
                      {p.screenshots[0] && <img src={p.screenshots[0].url} alt={`${p.title} screenshot`} loading="lazy" className="h-full w-full object-contain" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold">{p.title}</span>
                      <span className="block text-[12.5px]" style={{ color: 'var(--muted)' }}>{byline(p)}</span>
                      <span className="block min-w-0 truncate text-[12px]" style={{ color: 'var(--muted)' }}>{diskLine(disks)}</span>
                    </span>
                  </label>
                  <button type="button" data-testid="review-dismiss" data-production-id={p.id}
                    className="self-start rounded-full px-3 py-1 text-[12.5px] font-semibold sm:self-auto" style={{ color: 'var(--muted)' }}
                    onClick={() => dismiss(item.gameId, p.id)}>
                    Not this
                  </button>
                </li>
              );
            })}
            {/*
             * Multi-candidate rows use radios (native HTML gives no way to
             * click a radio back to "unselected"), so without an explicit
             * option a person who picked the wrong candidate could not get
             * back to "skip this title" short of reloading the page. A
             * single-candidate row doesn't need this: its one option is a
             * checkbox, which natively un-ticks.
             */}
            {item.suggestions.length > 1 && (
              <li className="flex items-center gap-3 pt-1">
                <label className="flex items-center gap-3">
                  <input type="radio" name={`pick-${item.gameId}`} checked={picked[item.gameId] === null}
                    onChange={() => setOverrides((s) => ({ ...s, [item.gameId]: null }))}
                    data-testid="review-skip" />
                  <span className="text-[12.5px]" style={{ color: 'var(--muted)' }}>Skip for now</span>
                </label>
              </li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}
