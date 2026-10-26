'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { pageHeading } from '@/components/admin/page-heading';

/**
 * Confirmation for the one irreversible action in this app, on the shared Modal (C6 spec §3.4, Ruling 7).
 *
 * A CENTERED modal, not a popup anchored to the row's button. Plan 3b's rulings record a real wrong-target bug from
 * the latter shape: an open dropdown covered the NEXT row's Mount button, so clicking what looked like disk 2's
 * control silently acted on disk 1. That failure mode is intolerable here -- the action is a permanent delete -- so
 * nothing is drawn over the table's other rows.
 *
 * The typed-email gate is the real protection: the operator must type THIS row's address exactly, so even a
 * mis-aimed click cannot delete the wrong account. The blast radius is named in numbers, because "delete user"
 * understates what actually goes.
 *
 * An allowlisted address (`isAdmin`, decided on the server) gets an aria-disabled trigger that does nothing; the
 * server's 409 stays as the backstop (Ruling 10).
 */
export function DeleteUserDialog({
  userId, email, games, disks, devices, orgName, isAdmin,
}: {
  userId: string; email: string; games: number; disks: number; devices: number; orgName: string | null;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Set by a successful delete: the row (and this trigger) goes with the refresh that lands AFTER the dialog closes,
  // so the h1 takes focus rather than a trigger about to vanish (Plan ruling, Task 3).
  const deleted = useRef(false);

  // Exact match. Not trimmed and not case-folded: this is a confirmation gesture, and making it forgiving is making
  // it easier to do by accident.
  const armed = typed === email;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setTyped('');
  }

  function finalFocus(): HTMLElement | null {
    if (deleted.current) return pageHeading();
    return trigger.current && document.contains(trigger.current) ? trigger.current : pageHeading();
  }

  async function onDelete() {
    if (!armed || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (res.status === 409) {
        toast.error('That account is allowlisted', {
          description: 'Deleting it would free an admin address for whoever registers it next.',
        });
        return;
      }
      if (!res.ok) {
        toast.error('Could not delete the user', { description: `The server answered ${res.status}.` });
        return;
      }
      const removed = await res.json();
      toast.success(`Deleted ${email}`, {
        description: `${removed.games} games, ${removed.disks} disks, ${removed.devices} devices.`,
      });
      deleted.current = true;
      setOpen(false);
      setTyped('');
      router.refresh();
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid={`delete-user-${email}`}
        aria-label={`Delete ${email}`}
        aria-disabled={isAdmin ? 'true' : undefined}
        title={isAdmin ? 'An admin account cannot be deleted' : undefined}
        onClick={() => { if (isAdmin) return; deleted.current = false; setOpen(true); }}
        className="h-[34px] max-sm:min-h-11 rounded-[9px] px-3 text-[13px] font-medium text-(--danger-fg) hover:bg-(--danger-bg) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) aria-disabled:cursor-default aria-disabled:text-(--muted-2) aria-disabled:hover:bg-transparent"
      >
        Delete…
      </button>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        width={440}
        testId="delete-user-dialog"
        closeTestId="delete-user-close"
        title="Delete this account?"
        subtitle={<span className="font-mono [overflow-wrap:anywhere]">{email}</span>}
        dismissible={!busy}
        initialFocus={field}
        finalFocus={finalFocus}
        footer={(
          <div className="flex w-full items-center justify-end gap-2.5">
            <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) onOpenChange(false); }}
                    className="h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60">
              Cancel
            </button>
            {/* Native disabled is the typed gate (not focused while not armed); busy is aria-disabled + the guard. */}
            <button type="button" onClick={onDelete} disabled={!armed} aria-disabled={busy || undefined}
                    className="h-[38px] rounded-[10px] px-4 text-[13px] font-semibold text-white disabled:opacity-50 aria-disabled:opacity-60"
                    style={{ background: 'var(--danger-fg)' }}>
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        )}
      >
        <div className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--muted)' }}>
          <p>
            This permanently removes <strong>{email}</strong>
            {orgName ? <> and the organization <strong>{orgName}</strong></> : null}, along with{' '}
            <strong>{games}</strong> games, <strong>{disks}</strong> disks and{' '}
            <strong>{devices}</strong> devices. It cannot be undone.
          </p>
          <p>
            Stored disk images are <em>not</em> deleted — they are shared between
            organizations, so removing them would damage other libraries.
          </p>
          <label htmlFor={`confirm-${userId}`} className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            Type the email to confirm
          </label>
          <input
            ref={field}
            id={`confirm-${userId}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="-mt-2 h-10 rounded-[10px] px-3 font-mono text-[13px]"
            style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
        </div>
      </Modal>
    </>
  );
}
