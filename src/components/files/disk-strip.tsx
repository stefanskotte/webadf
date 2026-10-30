'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { DiskInfo, StripData } from '@/lib/files/types';
import { holderText, type MountChoice } from '@/lib/mount-choice';
import { mountFailureText, mountRequest } from '@/lib/mount-request';
import { ejectMessage, isMountedReason, mountedReason } from '@/lib/mount-wording';
import { driveLight, formatKb } from '@/lib/disk-files-look';
import { AMIGA_NAME_MAX } from '@/lib/files/path';
import { DiskIcon } from '@/components/ui/disk-icon';
import { MountAction } from '@/components/games/mount-action';
import { HistoryPanel } from '@/components/disks/history-panel';
import { RestoreProvider } from '@/components/disks/restore-dialog';

/**
 * The disk strip (Files increment 1, Task 9; mock-up files-from-disk.html parts 1 and 2): what the old Browse page's
 * Disk card carried, in one row above a pane that is inside a disk -- the drive it is in, Mount (or Eject to edit
 * while a board holds it), the space, History over the pane, the .adf download and the volume name -- and its
 * "Your copy of <name>'s library" notice for a person's own copy of a shared title.
 *
 * The Mount menu, the History panel and the Restore confirm are the Browse page's own components. `onChanged` is
 * called after anything here changed the disk or its drive (an eject, a rename, a restore): the manager reloads the
 * panes showing it and this strip's data.
 */
export type DiskStripProps = { side: 'left' | 'right'; disk: DiskInfo; data: StripData; onChanged(): void };

const LIGHT = { in: 'var(--online-dot)', moving: 'var(--fetch-dot)', stale: 'var(--fetch-dot)', none: 'var(--dash)' } as const;
const BTN = 'inline-flex h-[30px] max-sm:min-h-11 shrink-0 items-center rounded-[8px] border px-2.5 text-[12px] font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-(--ring)';
const BTN_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' } as const;

const noSubscribe = () => () => {};

/** "A", "A and B", "A, B and C" -- holderText's join. */
function names(list: MountChoice[]): string {
  const n = list.map((c) => c.name);
  return n.length === 1 ? n[0] : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/**
 * The drive chip's words. A confirmed drive is named the Amiga way ("In DF0: of A500 bench"); anything not yet
 * confirmed keeps holderText's wording, which never begins with "In" (desired state is not fact).
 */
export function driveChip(choices: MountChoice[]): string {
  const df0 = choices.filter((c) => c.isThisDisk && c.state === 'converged');
  if (df0.length > 0) return `In DF0: of ${names(df0)}`;
  const df1 = choices.filter((c) => c.df1Held);
  if (df1.length > 0) return `In DF1: of ${names(df1)}`;
  return holderText(choices)?.text ?? 'Not in a drive';
}

/** "857 of 880 KB · 23 KB free", or that it is not known. */
export function usageLine(d: Pick<DiskInfo, 'usedBytes' | 'freeBytes' | 'totalBytes'>): string {
  if (d.usedBytes === null || d.freeBytes === null || d.totalBytes === null) return 'Free space unknown';
  return `${Math.round(d.usedBytes / 1024)} of ${formatKb(d.totalBytes)} · ${formatKb(d.freeBytes)} free`;
}

/** The drives holding this disk, each with the drive the eject names. */
function holdersOf(choices: MountChoice[]): { choice: MountChoice; drive: 'df0' | 'df1' }[] {
  return choices.flatMap((c) => [
    ...(c.isThisDisk ? [{ choice: c, drive: 'df0' as const }] : []),
    ...(c.df1?.isThisDisk ? [{ choice: c, drive: 'df1' as const }] : []),
  ]);
}

export function DiskStrip({ side, disk, data, onChanged }: DiskStripProps) {
  // "Version history" links (the library's title menu, Extract's "Open it") still name the old address with
  // #disk-history; it redirects here with the disk on the right, so that strip starts with its History open. Read after
  // hydration: the server never sees the fragment.
  const askedForHistory = useSyncExternalStore(noSubscribe, () => window.location.hash === '#disk-history', () => false);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const historyOpen = toggled ?? (side === 'right' && askedForHistory);
  // From lg the panel stays inside its pane (the bank and the other pane sit under and beside it): its height is the
  // room from its top to the pane's foot, and it scrolls inside. Below lg the page scrolls it instead (no cap here).
  const panelWrap = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  useEffect(() => {
    const wrap = panelWrap.current;
    const pane = wrap?.closest('section');
    if (!historyOpen || !wrap || !pane) return;
    const wide = window.matchMedia('(min-width: 1024px)');
    const measure = () => setRoom(wide.matches ? Math.max(0, Math.floor(pane.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top - 8)) : null);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    ro.observe(wrap.parentElement!);
    wide.addEventListener('change', measure);
    return () => { ro.disconnect(); wide.removeEventListener('change', measure); };
  }, [historyOpen]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(disk.volumeName ?? '');
  const holders = holdersOf(data.choices);
  const holderName = disk.holder ?? holders[0]?.choice.name ?? null;
  const locked = holderName ? ejectMessage(mountedReason(holderName), 'renaming') : null;
  const light = driveLight(data.choices);
  const pct = disk.usedBytes !== null && disk.totalBytes ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;

  /** Eject to edit: the eject the Mount menu sends (mount-request.ts), for every drive holding this disk. */
  async function eject() {
    setBusy(true);
    try {
      for (const h of holders) {
        const req = mountRequest(h.choice, disk.diskId, h.drive);
        const res = await fetch(req.url, req.init);
        if (!res.ok) {
          toast.error('Could not eject', { description: mountFailureText(await res.json().catch(() => null), res.status, req) });
          return;
        }
      }
      // Requested, not done: the board lets go on its next poll, and the live refresh shows it.
      toast.success('Eject requested');
      onChanged();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    const trimmed = name.trim();
    setEditing(false);
    if (trimmed === '' || trimmed === disk.volumeName) { setName(disk.volumeName ?? ''); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${disk.diskId}/volume-name`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ volumeName: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
        toast.error('Could not rename the disk', {
          description: res.status === 409 && body?.error === 'mounted' && body.reason && isMountedReason(body.reason)
            ? ejectMessage(body.reason, 'renaming') : undefined,
        });
        setName(disk.volumeName ?? '');
        onChanged();
        return;
      }
      toast.success('Disk renamed', { description: 'The disk was rewritten under a new digest.' });
      onChanged();
    } catch {
      toast.error('Could not reach the server');
      setName(disk.volumeName ?? '');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={`disk-strip-${side}`} className="relative flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3.5 py-2.5"
         style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
      <DiskIcon className="shrink-0" size={28} color={data.color} hd={disk.hd} />
      <span className="min-w-0 truncate text-[16px] font-bold" style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
        {disk.title}
      </span>
      {/* data-state: the drive light as the Browse Disk card gave it ('in' | 'moving' | 'stale' | 'none'). */}
      <span data-testid="disk-strip-light" data-state={light}
            className="inline-flex items-center gap-[5px] rounded-full px-2 py-0.5 text-[11.5px] font-medium"
            style={light === 'in' ? { background: 'var(--success-bg)', color: 'var(--success-fg)' }
              : { background: 'var(--track)', color: light === 'stale' ? 'var(--amber-text)' : 'var(--muted)' }}>
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: LIGHT[light] }} />
        <span data-testid="disk-strip-drive">{driveChip(data.choices)}</span>
      </span>
      {disk.volumeName !== null && (
        <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
          {editing ? (
            <input data-testid="disk-strip-volume-input" aria-label="Volume name" autoFocus maxLength={AMIGA_NAME_MAX}
                   value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()}
                   onKeyDown={(e) => {
                     // The manager's keys (F2, Delete, arrows) must not act on the pane while typing here.
                     e.stopPropagation();
                     if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                     if (e.key === 'Escape') { setName(disk.volumeName ?? ''); setEditing(false); }
                   }}
                   className="w-[16ch] rounded border bg-transparent px-1 py-0.5" style={{ borderColor: 'var(--line)', color: 'var(--ink)' }} />
          ) : (
            <span data-testid="disk-strip-volume" className="truncate">{disk.volumeName}</span>
          )}
          {!editing && (
            <button type="button" data-testid="disk-strip-volume-edit" disabled={busy || locked !== null}
                    aria-label="Rename the volume" title={locked ?? 'Rename the volume'}
                    onClick={() => { setName(disk.volumeName ?? ''); setEditing(true); }}
                    className="rounded-[4px] px-0.5 max-sm:min-h-11 max-sm:min-w-11 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-(--ring)">
              <span aria-hidden>✎</span>
            </button>
          )}
        </span>
      )}
      <span aria-hidden className="flex-1" />
      <div className="flex flex-col items-end gap-1 text-[11.5px]" style={{ color: 'var(--muted)' }}>
        <span data-testid="disk-strip-usage">{usageLine(disk)}</span>
        {pct !== null && (
          <span role="meter" aria-label="Disk space used" aria-valuemin={0}
                aria-valuemax={Math.round(disk.totalBytes! / 1024)} aria-valuenow={Math.round(disk.usedBytes! / 1024)}
                aria-valuetext={`${formatKb(disk.usedBytes!)} used of ${formatKb(disk.totalBytes!)}`}
                data-testid="disk-strip-meter" className="block h-1.5 w-[120px] overflow-hidden rounded-[3px]" style={{ background: 'var(--track)' }}>
            <span className="block h-full" style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--accent-amber)' : 'var(--ink)' }} />
          </span>
        )}
      </div>
      {holders.length > 0 ? (
        <button type="button" data-testid="disk-strip-eject" disabled={busy} onClick={() => void eject()}
                title={locked ?? undefined} className={BTN} style={BTN_STYLE}>Eject to edit</button>
      ) : (
        <MountAction diskId={disk.diskId} choices={data.choices} />
      )}
      <button type="button" data-testid="disk-strip-history-toggle" aria-expanded={historyOpen}
              onClick={() => setToggled(!historyOpen)} className={BTN} style={BTN_STYLE}>
        {data.headSeq === null ? 'History' : `History · v${data.headSeq}`}
      </button>
      <a href={`/api/disks/${disk.diskId}/adf`} data-testid="disk-strip-adf" className={BTN} style={BTN_STYLE}
         title={`Download ${disk.label} as an .adf`}>⬇ ADF</a>
      {/* The Browse page's notice under its breadcrumb, on a line of its own. */}
      {data.copiedFrom && (
        <p data-testid="disk-copied-from" className="basis-full text-[13px]" style={{ color: 'var(--muted)' }}>{data.copiedFrom}</p>
      )}

      {/* Below lg the History over a short pane runs past the page's foot, and the page then ends at the panel's
          bottom -- under the fixed tab bar, so at full scroll its last versions were out of reach. The wrapper reaches
          a bar's height (and a gutter) further down, so the page scrolls the whole panel clear of the bar; it lets
          taps through, so the strip of pane it covers stays usable. */}
      {historyOpen && (
        <div ref={panelWrap} className="pointer-events-none absolute top-full right-2 z-20 mt-1 w-[min(380px,calc(100%-16px))] max-lg:pb-[calc(4.5rem+env(safe-area-inset-bottom)+8px)]">
        <div data-testid="disk-strip-history"
             className="pointer-events-auto max-h-[min(520px,60dvh)] overflow-y-auto rounded-[20px]"
             style={{ boxShadow: '0 12px 24px rgb(0 0 0 / .12)', ...(room !== null ? { maxHeight: `min(${room}px, 520px, 60dvh)` } : {}) }}>
          <RestoreProvider diskId={disk.diskId} viewingSeq={null} currentHref={`/disks/${disk.diskId}/files`} onRestored={onChanged}>
            {data.historyUnavailable ? (
              <div className="p-4 text-[13px]" style={{ background: 'var(--surface)', color: 'var(--amber-text)' }}
                   data-testid="history-unavailable">
                This disk&apos;s version history could not be loaded.
              </div>
            ) : (
              <HistoryPanel diskId={disk.diskId} from={undefined} versions={data.history} viewingSeq={null}
                            mountedMessage={holderName ? ejectMessage(mountedReason(holderName)) : null} />
            )}
          </RestoreProvider>
        </div>
        </div>
      )}
    </div>
  );
}
