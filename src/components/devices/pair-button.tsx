'use client';

import { useState } from 'react';
import { toast } from 'sonner';

export function PairButton() {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch('/api/devices/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New device' }),
      });
      if (!res.ok) {
        toast.error('Could not mint a pairing code', { description: `The server answered ${res.status}.` });
        return;
      }
      const { code } = await res.json();
      setCode(code);
    } finally {
      setBusy(false);
    }
  }

  if (code) {
    return (
      <div className="flex flex-col items-end gap-1" data-testid="pairing-code">
        <span className="font-mono text-[20px] font-bold tracking-[0.14em]"
              style={{ color: 'var(--on-dark)' }}>{code}</span>
        <span className="text-[11px]" style={{ color: 'var(--on-dark-muted)' }}>
          enter this on the device
        </span>
      </div>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={busy} data-testid="pair-device"
            className="rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--primary-action)' }}>
      {busy ? 'Minting…' : 'Pair a device'}
    </button>
  );
}
