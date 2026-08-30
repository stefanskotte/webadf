'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function WriteProtectToggle({ diskId, writeProtected }: { diskId: string; writeProtected: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onToggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${diskId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ writeProtected: !writeProtected }),
      });
      if (!res.ok) {
        toast.error('Could not change write protection', { description: `The server answered ${res.status}.` });
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onToggle} disabled={busy}
            data-testid={`wp-${diskId}`} data-protected={writeProtected ? 'true' : 'false'}
            aria-pressed={writeProtected}
            title={writeProtected
              ? 'Write protected — the device will refuse writes'
              : 'Writable — the device may write to this disk once write-back ships'}
            className="rounded-md border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide disabled:opacity-50"
            style={writeProtected
              ? { borderColor: 'var(--hairline)', color: 'var(--muted)' }
              : { borderColor: 'var(--amber-text)', color: 'var(--amber-text)' }}>
      {writeProtected ? 'Protected' : 'Writable'}
    </button>
  );
}
