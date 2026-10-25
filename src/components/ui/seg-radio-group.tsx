'use client';

import { useRef, type KeyboardEvent } from 'react';
import { radioAfterKey } from '@/lib/settings-look';

/**
 * The C2/C3 roving radiogroup as one component (C5 spec §1.1, Ruling 4), used by Settings' three Preferences rows.
 * One tab stop (the checked radio, else the first); the arrows, Home and End move focus AND select, as a radiogroup
 * does, so each step calls onChange. A key with Alt, Ctrl or Meta is left to the browser.
 */
export function SegRadioGroup<V extends string>({
  value, options, onChange, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, testId, disabled = false,
}: {
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  'aria-labelledby': string;
  'aria-describedby'?: string;
  testId: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const values = options.map((o) => o.value);
  const stop = values.includes(value) ? value : values[0];

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = radioAfterKey(values, value, e.key, { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });
    if (next === null) return;
    e.preventDefault();
    if (disabled) return;
    ref.current?.querySelector<HTMLElement>(`[data-testid="${testId}-${next}"]`)?.focus();
    if (next !== value) onChange(next);
  }

  return (
    <div ref={ref} role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}
         data-testid={testId} data-value={value} onKeyDown={onKeyDown} className="seg seg--sm flex-wrap">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value}
                tabIndex={o.value === stop ? 0 : -1} disabled={disabled} data-testid={`${testId}-${o.value}`}
                onClick={() => { if (o.value !== value) onChange(o.value); }}
                className="seg-item whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) disabled:opacity-60">
          {o.label}
        </button>
      ))}
    </div>
  );
}
