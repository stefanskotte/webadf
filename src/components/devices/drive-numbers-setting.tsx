'use client';
import type { KeyboardEvent } from 'react';
import type { DeviceListItem } from '@/lib/queries';
import { DRIVE_BASE_HINT, DRIVE_BASE_OPTIONS, type DriveBase } from '@/lib/drive-numbers';
import { HelpTip } from '@/components/help/help-tip';

/** Drive numbers (src/lib/drive-numbers.ts): DF0 + DF1 | DF1 + DF2 | DF2 + DF3 | DF3 only. Names the drives everywhere;
 *  the board is sent nothing. A controlled section of the Board settings modal, as Disk at startup is: it edits a draft
 *  and the modal's Save sends it. The radiogroup follows the WAI-ARIA radio pattern (one tab stop, arrows move). */
export function DriveNumbersSetting({ device, value, onChange, error, busy = false }: {
  device: DeviceListItem; value: DriveBase; onChange: (v: DriveBase) => void;
  /** A refused save, in words (drive-base-error-<id>). */
  error: string | null;
  busy?: boolean;
}) {
  const id = device.id;
  // Saving DF3 switches the second drive Off (drive-numbers-store.ts): say so before Save, not after.
  const dropsSecondDrive = value === 3 && device.driveBase !== 3 && device.secondDrive !== 'off';

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (busy) return;
    const at = DRIVE_BASE_OPTIONS.findIndex((r) => r.value === value);
    const target = DRIVE_BASE_OPTIONS[(at + dir + DRIVE_BASE_OPTIONS.length) % DRIVE_BASE_OPTIONS.length].value;
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="drive-base-${id}-${target}"]`)?.focus();
    onChange(target);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Drive numbers</span>
        <HelpTip topic="second-drive" />
      </div>
      <div role="radiogroup" aria-label="Drive numbers" data-testid={`drive-base-${id}`} data-value={value}
           onKeyDown={onKeyDown} className="seg seg--sm flex-wrap self-start">
        {DRIVE_BASE_OPTIONS.map((r) => (
          <button key={r.value} type="button" role="radio" aria-checked={value === r.value}
                  tabIndex={r.value === value ? 0 : -1} aria-disabled={busy}
                  data-testid={`drive-base-${id}-${r.value}`}
                  onClick={() => { if (!busy) onChange(r.value); }}
                  className="seg-item whitespace-nowrap">
            {r.label}
          </button>
        ))}
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`drive-base-hint-${id}`}>
        {DRIVE_BASE_HINT[value]}
      </span>
      {dropsSecondDrive && (
        <span className="text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid={`drive-base-drops-second-${id}`}>
          Saving also switches the board&apos;s second drive Off.
        </span>
      )}
      {error && (
        <span role="alert" className="text-[13px]" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`drive-base-error-${id}`}>{error}</span>
      )}
    </div>
  );
}
