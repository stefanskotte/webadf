'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { INK_BTN, INK_STYLE, OUTLINE_BTN, OUTLINE_STYLE } from '@/lib/settings-look';

/**
 * Remove… (library sharing spec §4.4): the library leaves this team's Remote list; its disks in drives are ejected
 * and the copies held for them are deleted. Disks someone already saved to (they became this library's own) stay.
 * After removing, `/remote` (the list itself refreshes; a library's own page goes back to the list).
 */
export function RemoveRemote({ id, name, testId = 'remote-remove' }: { id: string; name: string; testId?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/remote/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        setError(`Could not remove it (the server answered ${res.status}). Nothing was changed.`);
        return;
      }
      setOpen(false);
      toast.success(`Removed ${name}`);
      router.push('/remote');
      router.refresh();
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button ref={opener} type="button" data-testid={testId} onClick={() => { setError(null); setOpen(true); }}
              className={OUTLINE_BTN} style={OUTLINE_STYLE}>
        Remove…
      </button>
      {open && (
        <Modal open onOpenChange={(o) => { if (!o) setOpen(false); }} width={440} testId="remote-remove-dialog"
               closeTestId="remote-remove-close" title={`Remove ${name}?`} dismissible={!busy} finalFocus={opener}
               footer={(
                 <div className="flex w-full items-center justify-end gap-2.5">
                   <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) setOpen(false); }}
                           className={OUTLINE_BTN} style={OUTLINE_STYLE}>
                     Cancel
                   </button>
                   <button type="button" data-testid="remote-remove-confirm" aria-disabled={busy || undefined}
                           onClick={() => void remove()} className={INK_BTN}
                           style={{ ...INK_STYLE, background: 'var(--danger-fg)' }}>
                     {busy ? 'Removing…' : 'Remove'}
                   </button>
                 </div>
               )}>
          <div className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--ink)' }}>
            <p>
              {name} leaves your Remote list. Its disks are ejected from your drives first. Disks you have saved to are
              already yours and stay in your library.
            </p>
            {error && <p role="alert" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
