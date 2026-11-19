'use client';
import type { KeyboardEvent } from 'react';
import type { DeviceListItem } from '@/lib/queries';
import {
  ORIG_DRIVE_APPLIES, ORIG_DRIVE_HINT, ORIG_DRIVE_OPTIONS, origDrivePending, origDriveStatus, type OrigDriveMode,
} from '@/lib/orig-drive';
import { HelpTip } from '@/components/help/help-tip';

/** Original drive (rev C, src/lib/orig-drive.ts): Auto | Off. Shown only for a board with the expander. A controlled
 *  section of the Board settings modal, as Drive numbers is: it edits a draft and the modal's Save sends it. The board
 *  stores the setting and uses it at its next power-on only (operator ruling 2026-11-19), so the status line says
 *  what it does now and the last line when a change takes effect. */
export function OrigDriveSetting({ device, value, onChange, error, busy = false }: {
  device: DeviceListItem; value: OrigDriveMode; onChange: (v: OrigDriveMode) => void;
  /** A refused save, in words (orig-drive-error-<id>). */
  error: string | null;
  busy?: boolean;
}) {
  const id = device.id;
  if (!device.origDriveCapable) return null;
  const pending = origDrivePending(device);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (busy) return;
    const at = ORIG_DRIVE_OPTIONS.findIndex((r) => r.value === value);
    const target = ORIG_DRIVE_OPTIONS[(at + dir + ORIG_DRIVE_OPTIONS.length) % ORIG_DRIVE_OPTIONS.length].value;
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="orig-drive-${id}-${target}"]`)?.focus();
    onChange(target);
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`orig-drive-section-${id}`}>
      <div className="flex items-center gap-1">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Original drive</span>
        <HelpTip topic="orig-drive" />
      </div>
      <div role="radiogroup" aria-label="Original drive" data-testid={`orig-drive-${id}`} data-value={value}
           onKeyDown={onKeyDown} className="seg seg--sm flex-wrap self-start">
        {ORIG_DRIVE_OPTIONS.map((r) => (
          <button key={r.value} type="button" role="radio" aria-checked={value === r.value}
                  tabIndex={r.value === value ? 0 : -1} aria-disabled={busy}
                  data-testid={`orig-drive-${id}-${r.value}`}
                  onClick={() => { if (!busy) onChange(r.value); }}
                  className="seg-item whitespace-nowrap">
            {r.label}
          </button>
        ))}
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`orig-drive-hint-${id}`}>
        {ORIG_DRIVE_HINT[value]}
      </span>
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
        <span data-testid={`orig-drive-status-${id}`} data-active={String(device.origDriveActive)}>
          {origDriveStatus(device)}
        </span>
        {pending && <span data-testid={`orig-drive-pending-${id}`}>{' · Waiting for the board'}</span>}
      </span>
      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`orig-drive-applies-${id}`}>
        {ORIG_DRIVE_APPLIES}
      </span>
      {error && (
        <span role="alert" className="text-[13px]" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`orig-drive-error-${id}`}>{error}</span>
      )}
    </div>
  );
}
