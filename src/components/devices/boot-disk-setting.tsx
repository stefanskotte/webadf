'use client';
import type { KeyboardEvent } from 'react';
import type { DeviceListItem } from '@/lib/queries';
import { bootDiskNote, BOOT_DISK_FW, type BootDisk } from '@/lib/boot-disk';
import { HelpTip } from '@/components/help/help-tip';

/** Disk at startup (src/lib/boot-disk.ts): Last disk (default) | No disk. Applied by the server at the board's next
 *  power-up; nothing is sent to the board, so there is no "waiting for the board" state to show.
 *
 *  A controlled section of the Board settings modal (spec §8): it edits a draft (`value`), and the modal's Save sends
 *  it. The radiogroup follows the WAI-ARIA radio pattern: one tab stop on the checked radio, arrows move focus and
 *  the draft, disabled radios are skipped. */
const RADIOS: { value: BootDisk; label: string }[] = [
  { value: 'last', label: 'Last disk' }, { value: 'empty', label: 'No disk' },
];
const HINT: Record<BootDisk, string> = {
  last: 'The board puts the last disk back in DF0 when it starts.',
  empty: 'The board starts with DF0 empty.',
};

export function BootDiskSetting({ device, value, onChange, error, busy = false }: {
  device: DeviceListItem; value: BootDisk; onChange: (v: BootDisk) => void;
  /** A refused save, in words (boot-disk-error-<id>). */
  error: string | null;
  /** A save is running: the radios ignore presses (aria-disabled), as DF1's do. */
  busy?: boolean;
}) {
  const id = device.id;
  const note = bootDiskNote(device.bootDiskCapable);
  const radioDisabled = (v: BootDisk) => v === 'empty' && !device.bootDiskCapable;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (busy) return;
    const enabled = RADIOS.filter((r) => !radioDisabled(r.value));
    const at = enabled.findIndex((r) => r.value === value);
    if (at < 0 || enabled.length < 2) return;
    const target = enabled[(at + dir + enabled.length) % enabled.length].value;
    e.currentTarget.querySelector<HTMLElement>(`[data-testid="boot-disk-${id}-${target}"]`)?.focus();
    onChange(target);
  }

  // The tab stop sits on the checked radio, or on the first enabled one when the checked one is disabled.
  const enabledRadios = RADIOS.filter((r) => !radioDisabled(r.value));
  const stop = enabledRadios.some((r) => r.value === value) ? value : enabledRadios[0]?.value;

  const heading = (
    <div className="flex items-center gap-1">
      <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Disk at startup</span>
      <HelpTip topic="boards" />
    </div>
  );

  // A board that has never said which firmware it runs (just paired): nothing to offer or to ask for yet.
  if (device.firmwareVersion === null && device.bootDisk === 'last') {
    return (
      <div className="flex flex-col gap-2">
        {heading}
        <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`boot-disk-unknown-${id}`}>
          Shown once the board reports its firmware.
        </span>
      </div>
    );
  }
  // Older firmware, still on the default: one line saying what it does and what it needs, not a disabled choice.
  if (note && device.bootDisk === 'last') {
    return (
      <div className="flex flex-col gap-2">
        {heading}
        <span className="flex flex-wrap items-center gap-x-1 text-[13px]" style={{ color: 'var(--muted)' }}>
          <span data-testid={`boot-disk-fixed-${id}`}>Disk at startup: Last disk</span>
          <span data-testid={`boot-disk-note-${id}`}>— {note.charAt(0).toLowerCase() + note.slice(1)}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {heading}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div role="radiogroup" aria-label="Disk at startup" data-testid={`boot-disk-${id}`} data-value={value}
             onKeyDown={onKeyDown} className="seg seg--sm">
          {RADIOS.map((r) => (
            <button key={r.value} type="button" role="radio" aria-checked={value === r.value}
                    tabIndex={r.value === stop ? 0 : -1} disabled={radioDisabled(r.value)} aria-disabled={busy}
                    data-testid={`boot-disk-${id}-${r.value}`}
                    onClick={() => { if (!busy) onChange(r.value); }}
                    className="seg-item whitespace-nowrap disabled:opacity-50">
              {r.label}
            </button>
          ))}
        </div>
        {note && (
          <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`boot-disk-note-${id}`}>
            Needs firmware {BOOT_DISK_FW} or newer
          </span>
        )}
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`boot-disk-hint-${id}`}>{HINT[value]}</span>
      {error && (
        <span role="alert" className="text-[13px]" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`boot-disk-error-${id}`}>{error}</span>
      )}
    </div>
  );
}
