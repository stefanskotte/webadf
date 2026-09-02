'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link } from '@/components/shell/link';
import { toast } from 'sonner';

export interface MountTarget { id: string; name: string }

export function MountAction({ diskId, devices }: { diskId: string; devices: MountTarget[] }) {
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

  async function mount(deviceId: string) {
    setBusy(true);
    setExpanded(false);
    try {
      const res = await fetch(`/api/devices/${deviceId}/mount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diskId }),
      });
      if (!res.ok) {
        toast.error('Could not mount', { description: `The server answered ${res.status}.` });
        return;
      }
      // Requested, not mounted. The device still has to fetch ~2 MB and swap.
      toast.success('Mount requested');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const cls = 'rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50';
  const style = { background: 'var(--primary-action)' };

  if (devices.length === 0) {
    return (
      <Link href="/devices" data-testid={`mount-${diskId}-none`}
            className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold"
            style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
        Pair a device
      </Link>
    );
  }

  if (devices.length === 1) {
    return (
      <button type="button" onClick={() => mount(devices[0].id)} disabled={busy}
              data-testid={`mount-${diskId}`} className={cls} style={style}>
        {busy ? 'Mounting…' : 'Mount'}
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
           // Below `sm` the picker takes a full line of its own inside the
           // row's control block, so a fleet of several devices wraps into
           // readable buttons instead of a column of slivers; from `sm` up
           // it is the right-aligned inline group it has always been.
           className="flex w-full flex-wrap items-center justify-start gap-1.5 outline-none sm:w-auto sm:justify-end">
        {devices.map((d) => (
          <button key={d.id} type="button" onClick={() => mount(d.id)} disabled={busy}
                  data-testid={`mount-${diskId}-to-${d.id}`}
                  className="rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                  style={style}>
            {d.name}
          </button>
        ))}
        <button type="button" onClick={() => setExpanded(false)}
                className="rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold"
                style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button type="button" onClick={() => setExpanded(true)} disabled={busy}
            data-testid={`mount-${diskId}`} className={cls} style={style}>
      {busy ? 'Mounting…' : 'Mount to ▾'}
    </button>
  );
}
