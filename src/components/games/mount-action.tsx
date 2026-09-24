'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link } from '@/components/shell/link';
import { toast } from 'sonner';
import type { MountChoice } from '@/lib/mount-choice';

/**
 * Kept as an alias rather than deleted: disk-row.tsx and the game page both
 * named this type, and a MountChoice is a superset of what a target ever was.
 */
export type MountTarget = MountChoice;

export function MountAction({ diskId, choices }: { diskId: string; choices: MountChoice[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Focus the expanded group itself so a bare Escape (no explicit target)
  // still reaches this wrapper's onKeyDown -- otherwise, with focus left on
  // <body> after the trigger button unmounts, the keydown would never
  // bubble through an element that isn't an ancestor of the focused node.
  useEffect(() => {
    if (expanded) wrapperRef.current?.focus();
  }, [expanded]);

  /**
   * Both verbs, one request path. Mount names a disk; eject names none, and
   * means "hold nothing" -- so calling it off a pending fetch also drops
   * whatever the drive still has. mount-choice.ts is what decides which verb a
   * given device is offered, and words it accordingly ("Cancel", not "Eject",
   * when nothing has landed yet).
   */
  async function act(choice: MountChoice) {
    setBusy(true);
    setExpanded(false);
    const ejecting = choice.action === 'eject';
    try {
      const res = await fetch(
        `/api/devices/${choice.id}/${ejecting ? 'eject' : 'mount'}`,
        ejecting
          ? { method: 'POST' }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ diskId }),
            },
      );
      if (!res.ok) {
        // A refusal the person can act on carries its own sentence (e.g. a
        // long-track HFE on a board whose firmware is too old); anything
        // else falls back to the status.
        const body = await res.json().catch(() => null) as { reason?: unknown } | null;
        const reason = typeof body?.reason === 'string' ? body.reason : `The server answered ${res.status}.`;
        toast.error(ejecting ? 'Could not eject' : 'Could not mount', { description: reason });
        return;
      }
      // Requested, not done. A mount still has to fetch ~2 MB and swap, which
      // measured ~4 s on hardware, and either way the device only acts on its
      // next poll. The layout's live poller (src/components/shell/live-refresh.tsx)
      // is what turns this into fact once the board reports.
      toast.success(ejecting ? 'Eject requested' : 'Mount requested');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const cls = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50';
  const style = { background: 'var(--primary-action)' };
  // Eject is not destructive, but it IS the one action here that takes
  // something away, so it does not wear the primary colour.
  const ejectStyle = { borderColor: 'var(--hairline)', color: 'var(--ink)' };
  const ejectCls =
    'rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50';

  if (choices.length === 0) {
    return (
      <Link href="/devices" data-testid={`mount-${diskId}-none`}
            className="btn-like rounded-lg border px-3 py-1.5 text-[12px] font-semibold"
            style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
        Pair a device
      </Link>
    );
  }

  // One device: no list to choose from, so the button says what it will do.
  // It still flips to Eject when that device holds this disk -- the whole
  // point of the change is that a disk can be sent AND recalled from here.
  if (choices.length === 1) {
    const only = choices[0];
    const ejecting = only.action === 'eject';
    return (
      <button type="button" onClick={() => act(only)} disabled={busy}
              data-testid={ejecting ? `eject-${diskId}` : `mount-${diskId}`}
              title={only.holding ? `${only.name}: ${only.holding}` : `${only.name}: empty`}
              className={ejecting ? ejectCls : cls}
              style={ejecting ? ejectStyle : style}>
        {busy ? 'Working…' : ejecting ? only.actionLabel : 'Mount'}
      </button>
    );
  }

  // Several devices paired. An overlay anchored to this row would always
  // risk covering another row's controls in a tightly-spaced list -- below
  // with side="bottom", above with side="top", horizontal placement fragile
  // at narrow widths -- there is no positioning trick that structurally
  // cannot reach a sibling row's controls, and a wrong-target mount is too
  // sharp an edge to guard with collision heuristics. So this expands
  // INLINE, in normal document flow, instead of in a portal: the row itself
  // grows and pushes the rows below it down, so nothing is ever covered.
  if (expanded) {
    return (
      <div ref={wrapperRef} tabIndex={-1}
           data-testid={`mount-${diskId}-menu`}
           onKeyDown={(e) => { if (e.key === 'Escape') setExpanded(false); }}
           // A COLUMN, not the old wrapped row of bare names. Each device now
           // carries a second line saying what it is holding, and that only
           // reads as belonging to its button when the two stack together.
           className="flex w-full flex-col items-stretch gap-1.5 outline-none sm:w-auto sm:min-w-[15rem]">
        {choices.map((c) => {
          const ejecting = c.action === 'eject';
          return (
            <div key={c.id}
                 className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5"
                 style={{ background: 'var(--glass-strong)' }}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[12px] font-semibold"
                      style={{ color: 'var(--ink)' }}>{c.name}</span>
                {/*
                  What the drive is doing, always rendered when it is doing
                  anything -- this is the half the old picker left out, and the
                  reason a person had to open the Devices tab to find out which
                  unit was free. `stale` is amber because it is the one state
                  that means "we asked and nobody answered".
                */}
                <span className="truncate text-[10.5px]"
                      data-testid={`mount-status-${diskId}-${c.id}`}
                      style={{ color: c.state === 'stale' ? 'var(--amber-text)' : 'var(--muted)' }}>
                  {c.holding ?? 'empty'}
                </span>
              </span>
              <button type="button" onClick={() => act(c)} disabled={busy}
                      data-testid={ejecting
                        ? `eject-${diskId}-from-${c.id}`
                        : `mount-${diskId}-to-${c.id}`}
                      className={`shrink-0 ${ejecting ? ejectCls : cls}`}
                      style={ejecting ? ejectStyle : style}>
                {c.actionLabel}
              </button>
            </div>
          );
        })}
        <button type="button" onClick={() => setExpanded(false)}
                className="self-end rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold"
                style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
          Cancel
        </button>
      </div>
    );
  }

  // The trigger names the disk's situation, not the menu's: if some drive
  // already has this disk, that is the thing worth knowing before opening it.
  const holder = choices.find((c) => c.isThisDisk);
  return (
    <button type="button" onClick={() => setExpanded(true)} disabled={busy}
            data-testid={`mount-${diskId}`} className={cls} style={style}>
      {busy ? 'Working…' : holder ? `In ${holder.name} ▾` : 'Mount to ▾'}
    </button>
  );
}
