'use client';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * "Needs attention" (operator 2026-11-12): the board's last error and the stuck-start note in one amber strip with a
 * count, closed by default; Details (the second drive's caret style) opens the notes. One strip even for one note.
 * The notes stay in the DOM while closed (`hidden`), keeping device-error-<id> / device-last-boot-<id> and their
 * text addressable.
 */
export function AttentionStrip({ deviceId, error, lastBoot }: {
  deviceId: string; error: string | null; lastBoot: string | null;
}) {
  const [open, setOpen] = useState(false);
  const count = (error ? 1 : 0) + (lastBoot ? 1 : 0);
  if (count === 0) return null;
  const region = `device-attention-notes-${deviceId}`;
  return (
    <div className="mx-3 mb-3 min-w-0 rounded-[12px] px-3.5 py-2.5 text-[13px]"
         style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}
         data-testid={`device-attention-${deviceId}`} data-count={count}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 font-semibold">
          Needs attention · <span data-testid={`device-attention-count-${deviceId}`}>{count === 1 ? '1 note' : `${count} notes`}</span>
        </span>
        <button type="button" data-testid={`device-attention-toggle-${deviceId}`} aria-expanded={open} aria-controls={region}
                onClick={() => setOpen((o) => !o)}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[9px] border bg-transparent px-2.5 text-[12px] font-semibold max-sm:min-h-11"
                style={{ borderColor: 'var(--line-strong)', color: 'var(--warning-fg)' }}>
          Details
          <ChevronDown aria-hidden className="size-4 transition-transform" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
      </div>
      {/* overflowWrap: a device-reported error can be URL-shaped with no natural break point, which once gave the
          whole page horizontal scroll at 390px. */}
      <ul id={region} hidden={!open} className={open ? 'mt-2 flex flex-col gap-1.5 border-t pt-2' : 'hidden'}
          style={{ borderColor: 'var(--line-strong)', overflowWrap: 'anywhere' }}>
        {error && <li data-testid={`device-error-${deviceId}`}>{error}</li>}
        {lastBoot && <li data-testid={`device-last-boot-${deviceId}`}>{lastBoot}</li>}
      </ul>
    </div>
  );
}
