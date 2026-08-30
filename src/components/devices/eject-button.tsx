'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function EjectButton({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      // fetch itself rejects on a network failure (offline, DNS, aborted) --
      // before there is any Response to check `.ok` on. Without this inner
      // try/catch that rejection is unhandled and the button just silently
      // snaps back to "Eject" with nothing on screen.
      let res: Response;
      try {
        res = await fetch(`/api/devices/${deviceId}/eject`, { method: 'POST' });
      } catch {
        toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
        return;
      }
      if (!res.ok) {
        toast.error('Could not eject', { description: `The server answered ${res.status}.` });
        return;
      }
      // The eject is recorded. The device still has to act on it, which is why
      // the card will now read "Mounting..." rather than "No disk" -- desired
      // has changed, actual has not yet.
      toast.success('Eject requested');
      start(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} disabled={busy || pending}
            data-testid={`eject-${deviceId}`}
            className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
            style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
      {busy || pending ? 'Ejecting…' : 'Eject'}
    </button>
  );
}
