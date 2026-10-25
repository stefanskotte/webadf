'use client';
// One restore confirm for the History's Restore… and the banner's Restore this version (C4 spec §7.4, Ruling 27).
// The request and its outcomes are HistoryPanel's old confirmRestore, moved here; the dialog is the shared Modal.
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { ejectMessage } from '@/lib/mount-wording';
import { fmtTimeUtc } from '@/lib/format';
import type { HistoryVersion } from '@/lib/disk-history/history';

interface RestoreValue { ask(v: HistoryVersion): void; busy: boolean; reactiveMounted: string | null }
const RestoreContext = createContext<RestoreValue | null>(null);
export function useRestore(): RestoreValue {
  const v = useContext(RestoreContext);
  if (!v) throw new Error('useRestore must be used within a RestoreProvider');
  return v;
}

export function RestoreProvider({ diskId, viewingSeq, currentHref, children }: {
  diskId: string; viewingSeq: number | null; currentHref: string; children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Kept after close so the popup's text does not blank while it leaves.
  const [target, setTarget] = useState<HistoryVersion | null>(null);
  const [busy, setBusy] = useState(false);
  // A 409 hit mid-session, for the race the page's proactive mountedMessage cannot see (a board mounted after load).
  const [reactiveMounted, setReactiveMounted] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const toCurrent = useRef(false);

  function ask(v: HistoryVersion) {
    opener.current = document.activeElement as HTMLElement | null;
    toCurrent.current = false;
    setTarget(v);
    setOpen(true);
  }

  // Evaluated by the dialog as it closes: the h1 after a restore that leaves an old version; else the opener, or, if
  // the refreshed list no longer has it, the History heading (never <body>).
  function finalFocus(): HTMLElement | boolean | null {
    if (toCurrent.current) return document.querySelector<HTMLElement>('h1');
    const back = opener.current && document.contains(opener.current) ? opener.current : null;
    return back ?? document.getElementById('history-heading');
  }

  async function confirm(version: HistoryVersion) {
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${diskId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seq: version.seq }),
      });
      const data: { error?: string; reason?: string; recorded?: boolean } | null = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 409 && data?.error === 'mounted' && typeof data.reason === 'string') {
          const message = ejectMessage(data.reason);
          setReactiveMounted(message);
          toast.error(message);
          setOpen(false);
        } else if (res.status === 409) {
          toast.error('This disk changed since the page loaded.', {
            description: 'Reloading the history so it matches.',
          });
          router.refresh();
          setOpen(false);
        } else if (res.status === 404) {
          toast.error('That version is no longer available.');
          router.refresh();
          setOpen(false);
        } else if (res.status === 503) {
          toast.error('The disk image could not be read from storage right now.');
        } else {
          toast.error('Could not restore this version.');
        }
        // 503 and the generic failure leave the dialog open so the person can retry.
        return;
      }

      // A no-op restore (the target's bytes already were the head -- reachable whenever a disk went A -> B -> A)
      // records nothing; saying "Restored" there reads as a silently failed click.
      if (data?.recorded === false) {
        toast.success('Nothing to restore', {
          description: `Version ${version.seq} is already this disk's current content.`,
        });
      } else {
        toast.success(`Restored to version ${version.seq}`, { description: version.label });
      }
      if (viewingSeq !== null) {
        // The old version is no longer what the page should show (spec §3, Ruling 7).
        toCurrent.current = true;
        setOpen(false);
        router.replace(currentHref);
      } else {
        setOpen(false);
        router.refresh();
      }
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <RestoreContext.Provider value={{ ask, busy, reactiveMounted }}>
      {children}
      <Modal open={open} onOpenChange={setOpen} width={440} testId="restore-dialog" closeTestId="restore-close"
             dismissible={!busy} initialFocus={cancelRef} finalFocus={finalFocus}
             title={`Restore version ${target?.seq ?? ''}?`}
             subtitle={target ? <strong style={{ color: 'var(--ink)' }}>{target.label}</strong> : undefined}
             footer={(
               <div className="flex w-full items-center justify-end gap-2.5">
                 <button ref={cancelRef} type="button" data-testid="restore-cancel" disabled={busy}
                         onClick={() => setOpen(false)}
                         className="h-[38px] rounded-[10px] border px-4 text-[13px] font-semibold disabled:opacity-50"
                         style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
                   Cancel
                 </button>
                 <button type="button" data-testid="restore-confirm" disabled={busy || !target}
                         onClick={() => { if (target) void confirm(target); }}
                         className="h-[38px] rounded-[10px] px-4 text-[13px] font-semibold disabled:opacity-50"
                         style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
                   {busy ? 'Restoring…' : 'Restore'}
                 </button>
               </div>
             )}>
        <p className="px-6 py-4 text-[13px]" style={{ color: 'var(--muted)' }}>
          The disk goes back to how it was on {target ? fmtTimeUtc(target.createdAt) : ''}. This is saved as a new
          version, so nothing after it is lost.
        </p>
      </Modal>
    </RestoreContext.Provider>
  );
}
