'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { SortSelect } from '@/components/prefs/sort-select';
import { SegRadioGroup } from '@/components/ui/seg-radio-group';
import { CARD_STYLE, SETTINGS_CARD, SETTINGS_H2, SETTINGS_ROW, prefsStateLook } from '@/lib/settings-look';
import { savePrefs } from '@/lib/user-prefs-client';
import {
  BROWSE_SORT_OPTIONS, LIBRARY_PAGE_SIZES, LIBRARY_SORT_OPTIONS, LIBRARY_VIEWS, START_PAGES, prefsDiff,
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
  const router = useRouter();
  const startLabel = useId(); const startHint = useId();
  const viewLabel = useId(); const viewHint = useId();
  const sizeLabel = useId(); const sizeHint = useId();
  const libLabel = useId(); const libHint = useId();
  const browseLabel = useId(); const browseHint = useId();
  const [saved, setSaved] = useState(prefs);
  const [draft, setDraft] = useState(prefs);
  const [state, setState] = useState<'saved' | 'saving' | 'failed'>('saved');
  // Saves in flight. Only the last one to finish settles the line, so two quick changes cannot end on "Saving…".
  const pending = useRef(0);

  async function change(next: UserPrefs) {
    const diff = prefsDiff(saved, next);
    setDraft(next);
    setState('saving');
    pending.current += 1;
    try {
      const stored = await savePrefs(diff);
      setSaved(stored);
      if (pending.current === 1) { setDraft(stored); setState('saved'); }
      router.refresh();
    } catch {
      setDraft(saved);
      setState('failed');
      toast.error("Couldn't save your preferences. Try again.");
    } finally {
      pending.current -= 1;
    }
  }

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

/** One Preferences row (spec §2.2): the label and hint on the left, the control on the right; stacked below sm. */
function PrefRow({ labelId, hintId, label, hint, children }: {
  labelId: string; hintId: string; label: string; hint: string; children: React.ReactNode;
}) {
  return (
    <div className={`${SETTINGS_ROW} border-t py-3.5`} style={{ borderColor: 'var(--hairline)' }}>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span id={labelId} className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{label}</span>
        <span id={hintId} className="text-[13px]" style={{ color: 'var(--muted-2)' }}>{hint}</span>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
