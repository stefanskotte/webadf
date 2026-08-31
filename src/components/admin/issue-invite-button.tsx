'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Issues a code and keeps it on screen until the next issue.
 *
 * Unlike a device pairing code there is no countdown here: an invite lives
 * seven days, so showing a ticking clock would be theatre. It stays visible
 * because the operator's next move is to copy it into an email.
 */
export function IssueInviteButton() {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onClick() {
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch('/api/admin/invites', { method: 'POST' });
      } catch {
        toast.error('Could not reach the server', {
          description: 'Check your connection and try again.',
        });
        return;
      }
      if (!res.ok) {
        toast.error('Could not issue an invite', {
          description: `The server answered ${res.status}.`,
        });
        return;
      }
      const body = await res.json();
      setCode(body.code);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {code && (
        <span
          className="rounded-full px-3 py-1 font-mono text-[13px] font-semibold"
          style={{ background: 'var(--on-dark)', color: '#16273a' }}
          data-testid="new-invite-code"
        >
          {code}
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="h-[34px] rounded-full px-4 text-[13px] font-semibold disabled:opacity-50"
        style={{ background: 'var(--on-dark)', color: '#16273a' }}
      >
        {busy ? 'Issuing…' : 'Issue invite'}
      </button>
    </div>
  );
}
