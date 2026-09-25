'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { requestEject } from './device-actions';

export function EjectButton({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      // The card will now read "Ejecting…" rather than "No disk" once the
      // refresh lands -- desired has changed, actual has not yet.
      if (await requestEject(deviceId)) start(() => router.refresh());
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
