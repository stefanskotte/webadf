'use client';

import { Button } from '@/components/ui/button';
import { BANK_GRID, BANK_LABEL, type BankCommand } from '@/lib/files/bank';
import { PANE_DEVICES, type Device } from '@/lib/files/path';

/**
 * The bank under both panes (Files 2 §2.3): the device column (STASH:, LIBRARY:, NET: only -- never a board's volumes,
 * spec D1) and the six-by-three grid. Presentational: the manager decides every reason and runs every command. A
 * command that cannot apply is aria-disabled, not `disabled` (spec §2.3): it stays focusable, its reason is its tooltip
 * and its description (a visually hidden line a screen reader reads), and a click or Enter still reaches the manager,
 * which says the reason in a toast as the phone's More menu does. While an operation runs nothing is sent. The device
 * column comes first in the tab order. From lg only; below lg the pane's chips and the
 * phone bar do this. 24 px rows (WCAG 2.2's target size, the mock-up's height), so the bank takes little from the panes.
 */
export function ButtonBank(p: {
  device: Device | null; reasons: Record<BankCommand, string | null>; busy: boolean; showInfo: boolean; primaryCopy: boolean;
  onDevice(d: Device): void; onCommand(c: BankCommand): void;
}) {
  return (
    <div data-testid="files-bank" className="grid grid-cols-[120px_minmax(0,1fr)] border-t max-lg:hidden"
         style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
      <div role="group" aria-label="Devices" data-testid="files-devices" className="flex flex-col gap-1 border-r p-1.5" style={{ borderColor: 'var(--line)' }}>
        {PANE_DEVICES.map((d) => (
          <button key={d} type="button" aria-pressed={p.device === d} data-testid={`files-dev-${d}`} onClick={() => p.onDevice(d)}
                  className="min-h-6 rounded-[7px] border px-2 py-0.5 text-left font-mono text-[12px] focus-visible:outline-2 focus-visible:outline-(--ring)"
                  style={p.device === d ? { background: 'var(--ink)', color: 'var(--surface)', borderColor: 'var(--ink)' }
                    : { background: 'var(--surface)', color: 'var(--ink)', borderColor: 'var(--line)' }}>
            {d}:
          </button>
        ))}
      </div>
      <div role="group" aria-label="File actions" data-testid="files-grid" className="grid grid-cols-6 gap-1 p-1.5">
        {BANK_GRID.map((cmd, i) => {
          if (cmd === null) return <span key={`gap-${i}`} aria-hidden />;
          const reason = p.reasons[cmd];
          const off = reason !== null || p.busy;
          return (
            <span key={cmd} className="flex min-w-0">
              <Button size="sm" data-testid={`files-${cmd}`} onClick={() => { if (!p.busy) p.onCommand(cmd); }}
                      variant={cmd === 'delete' ? 'destructive' : cmd === 'copy' && p.primaryCopy ? 'default' : 'outline'}
                      aria-disabled={off || undefined} title={reason ?? undefined}
                      aria-describedby={reason !== null ? `files-why-${cmd}` : undefined}
                      aria-pressed={cmd === 'showinfo' ? p.showInfo : undefined}
                      className="h-auto min-h-6 w-full py-0.5 leading-tight whitespace-normal aria-disabled:cursor-default aria-disabled:opacity-50">
                {BANK_LABEL[cmd]}
              </Button>
              {reason !== null && <span id={`files-why-${cmd}`} className="sr-only">{reason}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
