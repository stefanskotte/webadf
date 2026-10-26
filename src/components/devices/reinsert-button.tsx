'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { requestEject } from './device-actions';
import { BOX_BTN, BOX_BTN_STYLE } from './box-button';

/**
 * "Re-insert last disk" on a board whose DF0 is empty (A4): mounts the disk the last web eject took out
 * (devices.last_disk_id). An ordinary mount -- the same route, the same toast, and the same Undo as a card's mount;
 * the drive was empty, so Undo is an eject.
 */
export function ReinsertButton({ deviceId, diskId, title, diskNo }: {
  deviceId: string; diskId: string; title: string; diskNo: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const label = diskNo !== null ? `${title}, disk ${diskNo}` : title;

  async function reinsert() {
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/devices/${deviceId}/mount`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diskId }),
        });
      } catch {
        toast.error('Could not reach the server');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { reason?: unknown } | null;
        toast.error('Could not mount', {
          description: typeof body?.reason === 'string' ? body.reason : `The server answered ${res.status}.`,
        });
        return;
      }
      toast.success('Mount requested', {
        action: { label: 'Undo', onClick: () => { void requestEject(deviceId).then((ok) => { if (ok) router.refresh(); }); } },
      });
      startRefresh(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" data-testid={`reinsert-${deviceId}`} disabled={busy || refreshing} onClick={() => void reinsert()}
            className={`${BOX_BTN} w-fit max-sm:w-full max-w-full flex-col !items-start !gap-0 py-1 text-left`} style={BOX_BTN_STYLE}>
      <span className="text-[13px] font-semibold">Re-insert last disk</span>
      <span className="text-[11px]" style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>{label}</span>
    </button>
  );
}
