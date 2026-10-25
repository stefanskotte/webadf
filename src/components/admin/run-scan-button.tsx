'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PlayIcon } from 'lucide-react';

/** Run now (C6 spec §5.1, Ruling 21: the words stay after a run). Busy is aria-disabled + the guard; no confirm (Ruling 20). */
export function RunScanButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/scan', { method: 'POST' });
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
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} aria-disabled={busy || undefined} data-testid="run-scan"
            className="inline-flex h-[42px] items-center gap-2 rounded-[10px] px-[18px] text-[14px] font-semibold text-white aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
            style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
      <PlayIcon aria-hidden className="size-3.5" />
      {/* A pass is bounded at ~240 s, so say it is working rather than looking hung. */}
      {busy ? 'Scanning…' : 'Run now'}
    </button>
  );
}
