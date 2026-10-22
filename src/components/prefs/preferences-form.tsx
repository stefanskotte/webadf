'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { SortSelect } from '@/components/prefs/sort-select';
import { savePrefs } from '@/lib/user-prefs-client';
import {
  BROWSE_SORT_OPTIONS, LIBRARY_PAGE_SIZES, LIBRARY_SORT_OPTIONS, LIBRARY_VIEWS, START_PAGES, prefsDiff,
  type LibraryViewMode, type StartPage, type UserPrefs,
} from '@/lib/user-prefs-schema';
import { pageSizeLabel } from '@/components/library/library-pager';

const START_PAGE_LABELS: Record<StartPage, string> = { library: 'Library', devices: 'Devices', upload: 'Upload' };
const LIBRARY_VIEW_LABELS: Record<LibraryViewMode, string> = { grid: 'Grid', table: 'Table' };

/**
 * Preferences: every per-user setting in one place. Saved together with an
 * explicit Save (unlike the in-page sort pickers, which save as they change):
 * a start page is something a person sets once and wants confirmed.
 */
export function PreferencesForm({ prefs }: { prefs: UserPrefs }) {
  const router = useRouter();
  const startId = useId();
  const startHint = useId();
  const libraryHint = useId();
  const viewId = useId();
  const viewHint = useId();
  const sizeId = useId();
  const sizeHint = useId();
  const [saved, setSaved] = useState(prefs);
  const [draft, setDraft] = useState(prefs);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  async function save() {
    setBusy(true);
    try {
      // Only what was changed here: a sort changed in another tab since this
      // page loaded must not be put back by a Save that never touched it.
      const next = await savePrefs(prefsDiff(saved, draft));
      setSaved(next);
      setDraft(next);
      toast.success('Preferences saved');
      router.refresh();
    } catch {
      toast.error("Couldn't save your preferences. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass-card flex flex-col gap-4 p-5" data-testid="preferences">
      <div>
        <h2 className="text-[13px] font-semibold">Preferences</h2>
        <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
          Yours alone, on every browser you sign in from. Others in your organization keep their own.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-2 text-[12px]">
            <label htmlFor={startId} className="font-semibold" style={{ color: 'var(--muted)' }}>Start page</label>
            <select id={startId} aria-describedby={startHint} data-testid="pref-start-page" value={draft.startPage}
                    onChange={(e) => setDraft({ ...draft, startPage: e.target.value as StartPage })}
                    className="h-8 rounded-lg border px-2 text-[12px]"
                    style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)', color: 'var(--ink)' }}>
              {START_PAGES.map((p) => <option key={p} value={p}>{START_PAGE_LABELS[p]}</option>)}
            </select>
          </span>
          <span id={startHint} className="text-[12px]" style={{ color: 'var(--muted)' }}>
            Where you land after signing in, and when you open the site&apos;s address.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <SortSelect label="Library order" options={LIBRARY_SORT_OPTIONS} value={draft.library.sort}
                      onChange={(sort) => setDraft({ ...draft, library: { ...draft.library, sort } })}
                      testId="pref-library-sort" describedBy={libraryHint} />
          <span id={libraryHint} className="text-[12px]" style={{ color: 'var(--muted)' }}>
            The library and Uncategorized. A collection keeps its own order.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-2 text-[12px]">
            <label htmlFor={viewId} className="font-semibold" style={{ color: 'var(--muted)' }}>Library opens in</label>
            <select id={viewId} aria-describedby={viewHint} data-testid="pref-library-view" value={draft.library.view}
                    onChange={(e) => setDraft({ ...draft, library: { ...draft.library, view: e.target.value as LibraryViewMode } })}
                    className="h-8 rounded-lg border px-2 text-[12px]"
                    style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)', color: 'var(--ink)' }}>
              {LIBRARY_VIEWS.map((v) => <option key={v} value={v}>{LIBRARY_VIEW_LABELS[v]}</option>)}
            </select>
          </span>
          <span id={viewHint} className="text-[12px]" style={{ color: 'var(--muted)' }}>
            How the library first shows. The grid and table buttons on the library switch views without changing this.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-2 text-[12px]">
            <label htmlFor={sizeId} className="font-semibold" style={{ color: 'var(--muted)' }}>Titles per page</label>
            <select id={sizeId} aria-describedby={sizeHint} data-testid="pref-library-page-size" value={String(draft.library.pageSize)}
                    onChange={(e) => {
                      const pageSize = LIBRARY_PAGE_SIZES.find((s) => String(s) === e.target.value);
                      if (pageSize !== undefined) setDraft({ ...draft, library: { ...draft.library, pageSize } });
                    }}
                    className="h-8 rounded-lg border px-2 text-[12px]"
                    style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)', color: 'var(--ink)' }}>
              {LIBRARY_PAGE_SIZES.map((s) => <option key={s} value={String(s)}>{pageSizeLabel(s)}</option>)}
            </select>
          </span>
          <span id={sizeHint} className="text-[12px]" style={{ color: 'var(--muted)' }}>
            In the grid and the table alike. The pager under the library changes it too.
          </span>
        </div>
        <SortSelect label="Disk file list order" options={BROWSE_SORT_OPTIONS} value={draft.browse.sort}
                    onChange={(sort) => setDraft({ ...draft, browse: { ...draft.browse, sort } })}
                    testId="pref-browse-sort" />
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={!dirty || busy} data-testid="prefs-save"
                className="btn-like rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ background: 'var(--primary-action)' }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid="prefs-state"
              role="status" aria-live="polite">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
      </div>
    </section>
  );
}
