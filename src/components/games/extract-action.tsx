'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { NOT_EXTRACTABLE } from '@/lib/hfe/messages';

/**
 * Extract as ADF, or -- when the HFE is not a clean AmigaDOS disk -- the one
 * line saying why not (show-both-values: never a silently absent button).
 */
export function ExtractAction({ diskId, extractable, reason }: {
  diskId: string; extractable: boolean; reason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!extractable) {
    return (
      <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--muted)' }}
            title={reason ?? undefined} data-testid={`extract-reason-${diskId}`}>
        {NOT_EXTRACTABLE}
      </span>
    );
  }

  async function onExtract() {
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${diskId}/extract`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Could not extract', { description: `The server answered ${res.status}.` });
        return;
      }
      toast.success('Extracted as ADF');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onExtract} disabled={busy} data-testid={`extract-${diskId}`}
            className="btn-like shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
            style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}>
      Extract as ADF
    </button>
  );
}
