'use client';

import { useId, useRef, useState } from 'react';
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
 * Preferences: every per-user setting in one place. Each change saves at once (A2, operator 2026-10-23), like the
 * in-page sort pickers -- and only the field that changed, so a sort changed in another tab since this page loaded
 * is never put back. A failed save puts the field back to what is stored and says so.
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
                    onChange={(e) => void change({ ...draft, startPage: e.target.value as StartPage })}
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
                      onChange={(sort) => void change({ ...draft, library: { ...draft.library, sort } })}
                      testId="pref-library-sort" describedBy={libraryHint} />
          <span id={libraryHint} className="text-[12px]" style={{ color: 'var(--muted)' }}>
            The library and Uncategorized. A collection keeps its own order.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-2 text-[12px]">
            <label htmlFor={viewId} className="font-semibold" style={{ color: 'var(--muted)' }}>Library opens in</label>
            <select id={viewId} aria-describedby={viewHint} data-testid="pref-library-view" value={draft.library.view}
                    onChange={(e) => void change({ ...draft, library: { ...draft.library, view: e.target.value as LibraryViewMode } })}
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
                      if (pageSize !== undefined) void change({ ...draft, library: { ...draft.library, pageSize } });
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
                    onChange={(sort) => void change({ ...draft, browse: { ...draft.browse, sort } })}
                    testId="pref-browse-sort" />
      </div>
      <span className="text-[12px]" style={{ color: state === 'failed' ? 'var(--danger-fg)' : 'var(--muted)' }}
            data-testid="prefs-state" role="status" aria-live="polite">
        {state === 'saving' ? 'Saving…' : state === 'failed' ? "Couldn't save. Try again" : 'All changes saved'}
      </span>
    </section>
  );
}
