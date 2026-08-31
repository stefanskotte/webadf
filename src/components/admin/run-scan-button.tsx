'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function RunScanButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch('/api/admin/scan', { method: 'POST' });
      } catch {
        toast.error('Could not reach the server', {
          description: 'Check your connection and try again.',
        });
        return;
      }
      if (!res.ok) {
        toast.error('The scan failed', { description: `The server answered ${res.status}.` });
        return;
      }
      const r = await res.json();
      toast.success(
        r.done ? 'Scan complete' : 'Batch done — more to do',
        {
          description: `${r.hashed} hashed · ${r.matched} matched · ${r.none} unmatched · `
            + `${r.ambiguous} ambiguous · ${r.merged} merged`,
        },
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid="run-scan"
      className="h-[34px] rounded-full px-4 text-[13px] font-semibold disabled:opacity-50"
      style={{ background: 'var(--on-dark)', color: '#16273a' }}
    >
      {/* A pass is bounded at ~240 s, so say it is working rather than looking hung. */}
      {busy ? 'Scanning…' : 'Run now'}
    </button>
  );
}
