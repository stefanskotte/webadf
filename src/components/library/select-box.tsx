'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { CheckIcon, MinusIcon } from 'lucide-react';
import type { GameListItem } from '@/lib/queries';
import { CAP_TITLE, SELECTION_CAP, canSelectPage, pageCheck } from '@/lib/library-selection';
import { titleLabel } from './title-controls';
import { useLibrarySelection } from './selection-provider';

// Real <input type="checkbox">es (spec §1.2, §5), drawn 22 px with appearance-none. Both states are drawn: an
// unticked box is an empty ring, never nothing (the "show both values" rule). The unticked ring is --muted-2, which
// clears 3:1 on the surface; --line-strong would not (Plan ruling, Task 3).
const BOX = 'peer size-[22px] shrink-0 cursor-pointer appearance-none rounded-[6px] border-2 '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 aria-disabled:cursor-default aria-disabled:opacity-50';
const ON_SURFACE = 'border-(--muted-2) bg-(--surface) checked:border-(--primary-action) checked:bg-(--primary-action) '
  + 'indeterminate:border-(--primary-action) indeterminate:bg-(--primary-action) focus-visible:outline-(--ring)';
const ON_INK = 'border-(--surface) bg-transparent checked:bg-(--surface) indeterminate:bg-(--surface) '
  + 'focus-visible:outline-(--surface)';

function Box({ input, onInk }: { input: ReactNode; onInk: boolean }) {
  const mark = `pointer-events-none absolute inset-0 m-auto size-3.5 opacity-0 ${onInk ? 'text-(--ink)' : 'text-white'}`;
  return (
    <span className="relative inline-grid size-[22px] shrink-0">
      {input}
      <CheckIcon aria-hidden strokeWidth={3} className={`${mark} peer-checked:opacity-100`} />
      <MinusIcon aria-hidden strokeWidth={3} className={`${mark} peer-indeterminate:opacity-100`} />
    </span>
  );
}

/** One title's box. At the 1,000 cap an unticked box is aria-disabled and says why (Ruling 6). */
export function SelectBox({ game: g }: { game: Pick<GameListItem, 'id' | 'title' | 'year' | 'diskCount'> }) {
  const sel = useLibrarySelection();
  const checked = sel.selected.has(g.id);
  const capped = !checked && sel.selected.size >= SELECTION_CAP;
  return (
    <Box onInk={false} input={(
      <input
        type="checkbox"
        data-testid="select-title"
        aria-label={`Select ${titleLabel(g)}`}
        checked={checked}
        aria-disabled={capped || undefined}
        title={capped ? CAP_TITLE : undefined}
        onChange={() => {
          if (capped) return;
          sel.dispatch({ type: 'toggle', title: { id: g.id, title: g.title, year: g.year, diskCount: g.diskCount } });
        }}
        className={`${BOX} ${ON_SURFACE}`}
      />
    )} />
  );
}

/**
 * "All on this page" (spec §1.3): ticked when every title of the page is, indeterminate when some are; it toggles
 * exactly this page. Refused, aria-disabled and titled, when ticking the page would pass the cap.
 */
export function PageSelectBox({ testId, label, onInk = false, inputRef }: {
  testId: string;
  /** The accessible name when no visible <label> wraps it. */
  label?: string;
  onInk?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const sel = useLibrarySelection();
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? own;
  const ids = sel.pageTitles.map((t) => t.id);
  const state = pageCheck(sel.selected, ids);
  const blocked = state !== 'all' && !canSelectPage(sel.selected, ids);
  // `indeterminate` is a DOM property with no attribute: set after every render that changes it.
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [ref, state]);
  return (
    <Box onInk={onInk} input={(
      <input
        ref={ref}
        type="checkbox"
        data-testid={testId}
        aria-label={label}
        checked={state === 'all'}
        aria-disabled={blocked || undefined}
        title={blocked ? CAP_TITLE : undefined}
        onChange={() => { if (!blocked) sel.dispatch({ type: 'togglePage', page: sel.pageTitles }); }}
        className={`${BOX} ${onInk ? ON_INK : ON_SURFACE}`}
      />
    )} />
  );
}
