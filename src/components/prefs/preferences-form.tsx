'use client';

import { useId } from 'react';
import { PrefRow } from '@/components/prefs/pref-row';
import { usePrefsChange } from '@/components/prefs/use-prefs-change';
import { SortSelect } from '@/components/prefs/sort-select';
import { SegRadioGroup } from '@/components/ui/seg-radio-group';
import { CARD_STYLE, SETTINGS_CARD, SETTINGS_H2, prefsStateLook } from '@/lib/settings-look';
import {
  BROWSE_SORT_OPTIONS, LIBRARY_PAGE_SIZES, LIBRARY_SORT_OPTIONS, LIBRARY_VIEWS, START_PAGES,
  type LibraryViewMode, type StartPage, type UserPrefs,
} from '@/lib/user-prefs-schema';
import { pageSizeLabel } from '@/components/library/library-pager';

const START_PAGE_LABELS: Record<StartPage, string> = { library: 'Library', devices: 'Devices', upload: 'Files' };
const LIBRARY_VIEW_LABELS: Record<LibraryViewMode, string> = { grid: 'Grid', table: 'Table' };

/**
 * Preferences: every per-user setting in one place. Each change saves at once (A2, operator 2026-10-23), like the
 * in-page sort pickers -- and only the field that changed, so a sort changed in another tab since this page loaded
 * is never put back. A failed save puts the field back to what is stored and says so.
 */
export function PreferencesForm({ prefs }: { prefs: UserPrefs }) {
  const startLabel = useId(); const startHint = useId();
  const viewLabel = useId(); const viewHint = useId();
  const sizeLabel = useId(); const sizeHint = useId();
  const libLabel = useId(); const libHint = useId();
  const browseLabel = useId(); const browseHint = useId();
  const { draft, state, change } = usePrefsChange(prefs);

  const look = prefsStateLook(state);
  return (
    <section id="prefs" aria-labelledby="prefs-heading" data-testid="preferences" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="prefs-heading" tabIndex={-1} className={SETTINGS_H2} style={{ color: 'var(--ink)' }}>Preferences</h2>
        <span data-testid="prefs-state" role="status" aria-live="polite" className="flex items-center gap-1.5 text-[12px]"
              style={{ color: look.fg }}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: look.dot }} />
          {look.text}
        </span>
      </div>
      <p className="mb-2 mt-1 text-[13px]" style={{ color: 'var(--muted-2)' }}>
        Yours alone, on every browser you sign in from. Others in your organization keep their own.
      </p>
      <PrefRow labelId={startLabel} hintId={startHint} label="Start page"
               hint="Where you land after signing in, and when you open the site's address.">
        <SegRadioGroup testId="pref-start-page" aria-labelledby={startLabel} aria-describedby={startHint}
                       value={draft.startPage} options={START_PAGES.map((p) => ({ value: p, label: START_PAGE_LABELS[p] }))}
                       onChange={(startPage: StartPage) => void change({ ...draft, startPage })} />
      </PrefRow>
      <PrefRow labelId={viewLabel} hintId={viewHint} label="Library opens in"
               hint="How the library first shows. The grid and table buttons on the library switch views without changing this.">
        <SegRadioGroup testId="pref-library-view" aria-labelledby={viewLabel} aria-describedby={viewHint}
                       value={draft.library.view} options={LIBRARY_VIEWS.map((v) => ({ value: v, label: LIBRARY_VIEW_LABELS[v] }))}
                       onChange={(view: LibraryViewMode) => void change({ ...draft, library: { ...draft.library, view } })} />
      </PrefRow>
      <PrefRow labelId={sizeLabel} hintId={sizeHint} label="Titles per page"
               hint="In the grid and the table alike. The pager under the library changes it too.">
        <SegRadioGroup testId="pref-library-page-size" aria-labelledby={sizeLabel} aria-describedby={sizeHint}
                       value={String(draft.library.pageSize)}
                       options={LIBRARY_PAGE_SIZES.map((s) => ({ value: String(s), label: pageSizeLabel(s) }))}
                       onChange={(v) => {
                         const pageSize = LIBRARY_PAGE_SIZES.find((s) => String(s) === v);
                         if (pageSize !== undefined) void change({ ...draft, library: { ...draft.library, pageSize } });
                       }} />
      </PrefRow>
      <PrefRow labelId={libLabel} hintId={libHint} label="Library order"
               hint="The library and Uncategorized. A collection keeps its own order.">
        <SortSelect bare labelledBy={libLabel} describedBy={libHint} options={LIBRARY_SORT_OPTIONS} value={draft.library.sort}
                    onChange={(sort) => void change({ ...draft, library: { ...draft.library, sort } })}
                    testId="pref-library-sort" />
      </PrefRow>
      <PrefRow labelId={browseLabel} hintId={browseHint} label="Disk file list order" hint="Folders always come first.">
        <SortSelect bare labelledBy={browseLabel} describedBy={browseHint} options={BROWSE_SORT_OPTIONS} value={draft.browse.sort}
                    onChange={(sort) => void change({ ...draft, browse: { ...draft.browse, sort } })}
                    testId="pref-browse-sort" />
      </PrefRow>
    </section>
  );
}
