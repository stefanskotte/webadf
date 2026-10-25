'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { pageHeading } from '@/components/admin/page-heading';

/** Revoke a live code (no confirm, as shipped: Ruling 20). The button goes with the refresh, so the h1 takes focus. */
export function RevokeInviteButton({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/invites/${code}`, { method: 'DELETE' });
      if (res.status === 409) {
        // Somebody signed up with it between the render and the click. Say so plainly: the code is gone as a
        // credential either way, but an account now exists because of it, and that is the operator's business.
        toast.error('Already used', { description: 'Someone signed up with this code, so it cannot be revoked.' });
        pageHeading()?.focus();
        router.refresh();
        return;
      }
      if (!res.ok && res.status !== 204) {
        toast.error('Could not revoke the code', { description: `The server answered ${res.status}.` });
        return;
      }
      toast.success(`Revoked ${code}`);
      pageHeading()?.focus();
      router.refresh();
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} aria-disabled={busy || undefined} data-testid={`revoke-${code}`}
            className="h-[30px] rounded-[8px] px-2.5 text-[13px] font-medium text-(--danger-fg) hover:bg-(--danger-bg) aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
      {busy ? 'Revoking…' : 'Revoke'}
    </button>
  );
}
