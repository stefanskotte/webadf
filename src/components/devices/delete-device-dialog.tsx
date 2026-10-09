'use client';
import { Trash2 } from 'lucide-react';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Confirming the removal of a paired board. Same shape as DeleteDiskDialog
 * (named consequences, no typed-name gate): the board itself is untouched and
 * can be paired again, so what the dialog owes the person is the list of what
 * actually happens, not a hurdle.
 *
 * Portalled to document.body for the same reason as DeleteDiskDialog: the
 * card is .glass-card (backdrop-filter), which would otherwise become the
 * containing block of the fixed overlay.
 *
 * Source for each line (device_client.c / main.c DC_HALTED handling): the
 * board gets a 401 on its next request, ejects, drops tracks it had not yet
 * uploaded, forgets its token and offers its setup network again.
 */
export function DeleteDeviceDialog({ deviceId, name }: { deviceId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Could not delete the device', { description: `The server answered ${res.status}.` });
        return;
      }
      toast.success('Device deleted');
      setOpen(false);
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" data-testid={`device-delete-${deviceId}`}
              aria-label={`Delete ${name}`} title={`Delete ${name}`}
              onClick={() => setOpen(true)}
              className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--danger-bg)] hover:text-[var(--danger-fg)]"
              style={{ color: 'var(--faint)' }}>
        <Trash2 size={14} strokeWidth={1.75} aria-hidden />
      </button>
    );
  }

  return createPortal((
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         style={{ background: 'rgb(11 18 28 / 0.55)' }}>
      <div role="dialog" aria-modal="true" aria-label={`Delete ${name}`}
           data-testid="device-delete-dialog"
           className="glass-card w-full max-w-[440px] p-6 text-left">
        <h2 className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>Delete this device?</h2>
        <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
          <strong style={{ color: 'var(--ink)' }}>{name}</strong> will be removed from your account.
        </p>
        <ul className="mt-3 flex flex-col gap-1 text-[12.5px]" style={{ color: 'var(--muted)' }}>
          <li>The board stops working with this account. On its next contact it ejects its disk and
            offers its setup network again, so you can pair it with a new code.</li>
          <li>Changes the Amiga wrote that had not reached the server yet are lost.</li>
          <li>Your disks and their history are kept.</li>
        </ul>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" data-testid="device-delete-cancel" disabled={busy}
                  onClick={() => setOpen(false)}
                  className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50"
                  style={{ color: 'var(--muted)' }}>
            Cancel
          </button>
          <button type="button" data-testid="device-delete-confirm" disabled={busy}
                  onClick={confirm}
                  className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--danger-fg)' }}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
