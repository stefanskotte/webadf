'use client';

import { useId } from 'react';
import { sortOptionId, sortFromOptionId, type SortDir, type SortOption } from '@/lib/user-prefs-schema';

/**
 * A labelled sort picker over one of the option lists in user-prefs-schema.ts
 * (LIBRARY_SORT_OPTIONS, BROWSE_SORT_OPTIONS). Presentational only: saving is
 * the caller's (LibrarySortPicker, the Browse list, the Preferences form).
 */
export function SortSelect<S extends { key: string; dir: SortDir }>({
  label = 'Sort', options, value, onChange, disabled = false, testId, describedBy, toolbar = false, bare = false, labelledBy,
}: {
  label?: string;
  options: readonly SortOption<S>[];
  value: S;
  onChange: (next: S) => void;
  disabled?: boolean;
  testId?: string;
  /** The id of a hint that explains this picker (aria-describedby). */
  describedBy?: string;
  /** The library toolbar's look (40px, surface, line border); other callers keep the compact form field. */
  toolbar?: boolean;
  /** Only the select: the caller labels it (Settings' rows, C5 spec §1.4). */
  bare?: boolean;
  labelledBy?: string;
}) {
  const id = useId();
  if (bare) {
    return (
      <select
        data-testid={testId}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        value={sortOptionId(value)}
        disabled={disabled}
        onChange={(e) => {
          const next = sortFromOptionId(options, e.target.value);
          if (next) onChange(next);
        }}
        className="h-9 w-full min-w-[180px] rounded-[10px] border px-3 text-[13px] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) sm:w-auto max-sm:min-h-11"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
      >
        {options.map((o) => (
          <option key={sortOptionId(o.sort)} value={sortOptionId(o.sort)}>{o.label}</option>
        ))}
      </select>
    );
  }
  return (
    <span className={toolbar ? 'inline-flex items-center gap-2 text-[13px]' : 'inline-flex items-center gap-2 text-[12px]'}>
      <label htmlFor={id} className="font-semibold" style={{ color: 'var(--muted)' }}>{label}</label>
      <select
        id={id}
        data-testid={testId}
        aria-describedby={describedBy}
        value={sortOptionId(value)}
        disabled={disabled}
        onChange={(e) => {
          const next = sortFromOptionId(options, e.target.value);
          if (next) onChange(next);
        }}
        className={toolbar
          ? 'h-10 max-sm:min-h-11 rounded-[10px] border px-3 text-[14px] disabled:opacity-60'
          : 'h-8 rounded-lg border px-2 text-[12px] disabled:opacity-60'}
        style={toolbar
          ? { borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--ink)' }
          : { borderColor: 'var(--hairline)', background: 'var(--input-bg)', color: 'var(--ink)' }}
      >
        {options.map((o) => (
          <option key={sortOptionId(o.sort)} value={sortOptionId(o.sort)}>{o.label}</option>
        ))}
      </select>
    </span>
  );
}
