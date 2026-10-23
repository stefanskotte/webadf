'use client';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { tabTarget } from '@/lib/from-amiga-ui';

/**
 * The staging list's one confirm (spec 2026-10-23 §2): a modal. Cancel takes focus when it opens, Escape cancels, Tab
 * stays inside, and the control that opened it gets focus back when it closes.
 */
export function StagingConfirm({
  question, yes, busy, onYes, onCancel,
}: {
  question: string;
  yes: string;
  busy: boolean;
  onYes: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelRef.current(); return; }
      if (e.key !== 'Tab' || !dialog.current) return;
      const items = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
      const to = tabTarget(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
      if (to !== null) { e.preventDefault(); items[to].focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus(); };
  }, []);

  return createPortal((
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgb(11 18 28 / 0.55)' }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={yes} data-testid="staging-confirm"
           className="glass-card w-full max-w-[440px] p-6 text-left">
        <h2 className="text-[15px] font-bold" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{question}</h2>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" ref={cancelBtn} data-testid="staging-confirm-cancel" disabled={busy} onClick={onCancel}
                  className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50" style={{ color: 'var(--muted)' }}>Cancel</button>
          <button type="button" data-testid="staging-confirm-yes" disabled={busy} onClick={onYes}
                  className="rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50" style={{ background: 'var(--danger-fg)' }}>
            {yes}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
