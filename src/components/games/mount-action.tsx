'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

export interface MountTarget { id: string; name: string }

export function MountAction({ diskId, devices }: { diskId: string; devices: MountTarget[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function mount(deviceId: string) {
    setBusy(true);
    setOpen(false);
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

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} disabled={busy}
              data-testid={`mount-${diskId}`} aria-expanded={open} className={cls} style={style}>
        {busy ? 'Mounting…' : 'Mount to ▾'}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 flex min-w-[160px] flex-col overflow-hidden rounded-lg border"
             data-testid={`mount-${diskId}-menu`}
             style={{ borderColor: 'var(--hairline)', background: '#fff' }}>
          {devices.map((d) => (
            <button key={d.id} type="button" onClick={() => mount(d.id)}
                    data-testid={`mount-${diskId}-to-${d.id}`}
                    className="px-3 py-2 text-left text-[12px] hover:bg-black/5"
                    style={{ color: 'var(--ink)' }}>
              {d.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
