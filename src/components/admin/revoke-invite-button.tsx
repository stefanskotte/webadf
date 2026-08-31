'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function RevokeInviteButton({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/admin/invites/${code}`, { method: 'DELETE' });
      } catch {
        toast.error('Could not reach the server', {
          description: 'Check your connection and try again.',
        });
        return;
      }
      if (res.status === 409) {
        // Somebody signed up with it between the render and the click. Say so
        // plainly: the code is gone as a credential either way, but an account
        // now exists because of it, and that is the operator's business.
        toast.error('Already used', {
          description: 'Someone signed up with this code, so it cannot be revoked.',
        });
        router.refresh();
        return;
      }
      if (!res.ok && res.status !== 204) {
        toast.error('Could not revoke the code', {
          description: `The server answered ${res.status}.`,
        });
        return;
      }
      toast.success(`Revoked ${code}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={`revoke-${code}`}
      className="text-[12.5px] font-semibold disabled:opacity-50"
      style={{ color: 'var(--amber-text)' }}
    >
      {busy ? 'Revoking…' : 'Revoke'}
    </button>
  );
}
