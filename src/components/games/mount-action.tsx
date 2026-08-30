'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

export interface MountTarget { id: string; name: string }

export function MountAction({ diskId, devices }: { diskId: string; devices: MountTarget[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function mount(deviceId: string) {
    setBusy(true);
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

  // Several devices paired: a real menu, not a hand-rolled popover. Base UI's
  // Menu gives outside-click dismissal, Escape handling, focus management and
  // menu/menuitem ARIA roles for free -- a hand-rolled <div> version had none
  // of that (clicking elsewhere on the page left it open).
  return (
    // Modal (the Base UI default -- kept explicit here as a decision, not an
    // oversight). Two disk rows can each have their menu positioned close
    // enough that one row's popup visually overlaps another row's Mount
    // button; without the modal inert-overlay, a click that LOOKS like it
    // lands on disk 2's button can actually be intercepted by disk 1's open
    // menu underneath, mounting the wrong disk. The overlay makes that
    // impossible: outside clicks and Escape still close the menu (Base UI
    // handles both), but nothing behind the menu can receive a click while
    // it's open.
    <DropdownMenu modal>
      <DropdownMenuTrigger disabled={busy} data-testid={`mount-${diskId}`} className={cls} style={style}>
        {busy ? 'Mounting…' : 'Mount to ▾'}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        data-testid={`mount-${diskId}-menu`}
        className="min-w-[160px] overflow-hidden rounded-lg border p-0"
        style={{ borderColor: 'var(--hairline)', background: '#fff' }}
      >
        {devices.map((d) => (
          <DropdownMenuItem key={d.id} data-testid={`mount-${diskId}-to-${d.id}`}
                             onClick={() => mount(d.id)}
                             className="rounded-none px-3 py-2 text-[12px]"
                             style={{ color: 'var(--ink)' }}>
            {d.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
