'use client';
import type { KeyboardEvent } from 'react';
import type { DeviceListItem } from '@/lib/queries';
import { FITTED_AS_HINT, FITTED_AS_OPTIONS, type FittedAs } from '@/lib/fitted-as';
import { HelpTip } from '@/components/help/help-tip';

/** Fitted as (src/lib/fitted-as.ts): Inside the Amiga (DF0) | External drive case (DF1). Names the drive everywhere; the
 *  board is sent nothing. A controlled section of the Board settings modal, as Disk at startup is: it edits a draft
 *  and the modal's Save sends it. The radiogroup follows the WAI-ARIA radio pattern (one tab stop, arrows move). */
export function FittedAsSetting({ device, value, onChange, error, busy = false }: {
  device: DeviceListItem; value: FittedAs; onChange: (v: FittedAs) => void;
  /** A refused save, in words (fitted-as-error-<id>). */
  error: string | null;
  busy?: boolean;
}) {
  const id = device.id;
  // Saving External switches the second drive Off (fitted-as-store.ts): say so before Save, not after.
  const dropsSecondDrive = value === 'external' && device.fittedAs !== 'external' && device.secondDrive !== 'off';

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (busy) return;
    const at = FITTED_AS_OPTIONS.findIndex((r) => r.value === value);
    const target = FITTED_AS_OPTIONS[(at + dir + FITTED_AS_OPTIONS.length) % FITTED_AS_OPTIONS.length].value;
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="fitted-as-${id}-${target}"]`)?.focus();
    onChange(target);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Fitted as</span>
        <HelpTip topic="second-drive" />
      </div>
      <div role="radiogroup" aria-label="Fitted as" data-testid={`fitted-as-${id}`} data-value={value}
           onKeyDown={onKeyDown} className="seg seg--sm self-start">
        {FITTED_AS_OPTIONS.map((r) => (
          <button key={r.value} type="button" role="radio" aria-checked={value === r.value}
                  tabIndex={r.value === value ? 0 : -1} aria-disabled={busy}
                  data-testid={`fitted-as-${id}-${r.value}`}
                  onClick={() => { if (!busy) onChange(r.value); }}
                  className="seg-item whitespace-nowrap">
            {r.label}
          </button>
        ))}
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`fitted-as-hint-${id}`}>
        {FITTED_AS_HINT[value]}
      </span>
      {dropsSecondDrive && (
        <span className="text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid={`fitted-as-drops-df1-${id}`}>
          Saving also switches the board&apos;s second drive Off.
        </span>
      )}
      {error && (
        <span role="alert" className="text-[13px]" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`fitted-as-error-${id}`}>{error}</span>
      )}
    </div>
  );
}
