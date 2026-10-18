'use client';

import { useId } from 'react';
import { sortOptionId, sortFromOptionId, type SortDir, type SortOption } from '@/lib/user-prefs-schema';

/**
 * A labelled sort picker over one of the option lists in user-prefs-schema.ts
 * (LIBRARY_SORT_OPTIONS, BROWSE_SORT_OPTIONS). Presentational only: saving is
 * the caller's (LibrarySortPicker, the Browse list, the Preferences form).
 */
export function SortSelect<S extends { key: string; dir: SortDir }>({
  label = 'Sort', options, value, onChange, disabled = false, testId, describedBy,
}: {
  label?: string;
  options: readonly SortOption<S>[];
  value: S;
  onChange: (next: S) => void;
  disabled?: boolean;
  testId?: string;
  /** The id of a hint that explains this picker (aria-describedby). */
  describedBy?: string;
}) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2 text-[12px]">
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
        className="h-8 rounded-lg border px-2 text-[12px] disabled:opacity-60"
        style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)', color: 'var(--ink)' }}
      >
        {options.map((o) => (
          <option key={sortOptionId(o.sort)} value={sortOptionId(o.sort)}>{o.label}</option>
        ))}
      </select>
    </span>
  );
}
