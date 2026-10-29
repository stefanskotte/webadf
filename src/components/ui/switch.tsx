'use client';

/**
 * A two-state switch: a `role="switch"` button, the track and knob of the Hide .info switch in a disk's file list
 * (`--ink` track when on; `--line-strong` with an inset `--muted-2` ring when off, so "off" is visible as well as
 * said). The caller names it (aria-labelledby, aria-label) and says what each value means in words beside it.
 */
export function Switch({ checked, onChange, testId, disabled = false, ...aria }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
  disabled?: boolean;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-label'?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={aria['aria-labelledby']}
            aria-describedby={aria['aria-describedby']} aria-label={aria['aria-label']} disabled={disabled}
            data-testid={testId} onClick={() => onChange(!checked)}
            className="flex h-9 max-lg:min-h-11 items-center rounded-[9px] px-1 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
      <span aria-hidden className={`flex h-5 w-9 shrink-0 rounded-full p-0.5 ${checked ? 'justify-end' : 'justify-start'}`}
            style={checked ? { background: 'var(--ink)' } : { background: 'var(--line-strong)', boxShadow: 'inset 0 0 0 1px var(--muted-2)' }}>
        <span className="size-4 rounded-full" style={{ background: 'var(--surface)', boxShadow: '0 1px 2px rgb(0 0 0 / 0.25)' }} />
      </span>
    </button>
  );
}
