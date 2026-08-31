'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Confirmation for the one irreversible action in this app.
 *
 * A CENTERED modal, not a popup anchored to the row's button. Plan 3b's
 * rulings record a real wrong-target bug from the latter shape: an open
 * dropdown covered the NEXT row's Mount button, so clicking what looked like
 * disk 2's control silently acted on disk 1. That failure mode is intolerable
 * here -- the action is a permanent delete -- so nothing is drawn over the
 * table's other rows.
 *
 * The typed-email gate is the real protection, and it is stronger than a
 * click target: the operator must type THIS row's address exactly, so even a
 * mis-aimed click cannot delete the wrong account. The blast radius is named
 * in numbers, because "delete user" understates what actually goes.
 */
export function DeleteUserDialog({
  userId,
  email,
  games,
  disks,
  devices,
  orgName,
}: {
  userId: string;
  email: string;
  games: number;
  disks: number;
  devices: number;
  orgName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  // Exact match. Not trimmed and not case-folded: this is a confirmation
  // gesture, and making it forgiving is making it easier to do by accident.
  const armed = typed === email;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function onDelete() {
    if (!armed) return;
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      } catch {
        toast.error('Could not reach the server', {
          description: 'Check your connection and try again.',
        });
        return;
      }
      if (res.status === 409) {
        toast.error('That account is allowlisted', {
          description: 'Deleting it would free an admin address for whoever registers it next.',
        });
        return;
      }
      if (!res.ok) {
        toast.error('Could not delete the user', {
          description: `The server answered ${res.status}.`,
        });
        return;
      }
      const removed = await res.json();
      toast.success(`Deleted ${email}`, {
        description: `${removed.games} games, ${removed.disks} disks, ${removed.devices} devices.`,
      });
      setOpen(false);
      setTyped('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`delete-user-${email}`}
        className="text-[12.5px] font-semibold"
        style={{ color: 'var(--amber-text)' }}
      >
        Delete
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`delete-user-${email}`}
        className="text-[12.5px] font-semibold"
        style={{ color: 'var(--amber-text)' }}
      >
        Delete
      </button>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgb(0 0 0 / 0.45)' }}
        onClick={() => setOpen(false)}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Delete ${email}`}
          className="glass-card w-full max-w-[440px] p-6 text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-[18px] font-bold tracking-[-0.02em]">Delete this account?</h2>
          <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
            This permanently removes <strong>{email}</strong>
            {orgName ? <> and the organization <strong>{orgName}</strong></> : null}, along with{' '}
            <strong>{games}</strong> games, <strong>{disks}</strong> disks and{' '}
            <strong>{devices}</strong> devices. It cannot be undone.
          </p>
          <p className="mt-2 text-[12.5px]" style={{ color: 'var(--muted)' }}>
            Stored disk images are <em>not</em> deleted — they are shared between
            organizations, so removing them would damage other libraries.
          </p>

          <label
            htmlFor={`confirm-${userId}`}
            className="mt-4 block text-[12.5px] font-semibold"
          >
            Type the email to confirm
          </label>
          <input
            id={`confirm-${userId}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full rounded-md border px-3 py-2 font-mono text-[12.5px]"
            style={{ borderColor: 'rgb(0 0 0 / 0.18)' }}
          />

          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => { setOpen(false); setTyped(''); }}
              className="text-[13px] font-medium"
              style={{ color: 'var(--muted)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={!armed || busy}
              className="h-[34px] rounded-full px-4 text-[13px] font-semibold disabled:opacity-40"
              style={{ background: 'var(--amber-text)', color: '#fff' }}
            >
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
