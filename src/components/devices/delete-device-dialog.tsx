'use client';
import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Confirming the removal of a paired board. Same shape as DeleteDiskDialog
 * (named consequences, no typed-name gate): the board itself is untouched and
 * can be paired again, so what the dialog owes the person is the list of what
 * actually happens, not a hurdle.
 *
 * Controlled (Board settings opens it from its footer, spec §8.3, Ruling 23). Escape and Cancel close it unless
 * the request runs; the opener takes focus back through `onOpenChange`.
 *
 * Portalled to document.body for the same reason as DeleteDiskDialog: the
 * card is .glass-card (backdrop-filter), which would otherwise become the
 * containing block of the fixed overlay.
 *
 * Source for each line (device_client.c / main.c DC_HALTED handling): the
 * board gets a 401 on its next request, ejects, drops tracks it had not yet
 * uploaded, forgets its token and offers its setup network again.
 */
export function DeleteDeviceConfirm({ deviceId, name, open, onOpenChange, cancelRef }: {
  deviceId: string; name: string; open: boolean; onOpenChange: (open: boolean) => void;
  /** The Cancel button: the safe place for focus to land when the dialog opens. */
  cancelRef?: RefObject<HTMLButtonElement | null>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onOpenChange]);

  async function confirm() {
    setBusy(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error('Could not delete the device', { description: `The server answered ${res.status}.` });
        return;
      }
      toast.success('Device deleted');
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return createPortal((
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         style={{ background: 'var(--scrim)' }}>
      <div role="dialog" aria-modal="true" aria-label={`Delete ${name}`}
           data-testid="device-delete-dialog"
           className="glass-card wf-modal w-full max-w-[440px] p-6 text-left">
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
          <button type="button" ref={cancelRef} data-testid="device-delete-cancel" disabled={busy}
                  onClick={() => onOpenChange(false)}
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
