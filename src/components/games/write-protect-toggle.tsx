'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { requestWriteProtect } from '@/components/devices/device-actions';

export function WriteProtectToggle({ diskId, writeProtected }: { diskId: string; writeProtected: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onToggle() {
    setBusy(true);
    try {
      if (await requestWriteProtect(diskId, !writeProtected)) router.refresh();
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
              // --hairline is 8% and read as no border at all, which made this
              // toggle look like a status chip rather than the control it is --
              // the clearest instance of the operator's "hard to distinguish
              // labels and buttons". --hairline-strong (14%) is still quiet
              // enough not to compete with the actions beside it.
              ? { borderColor: 'var(--hairline-strong)', color: 'var(--muted)' }
              : { borderColor: 'var(--amber-text)', color: 'var(--amber-text)' }}>
      {writeProtected ? 'Protected' : 'Writable'}
    </button>
  );
}
