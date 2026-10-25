'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PlusIcon } from 'lucide-react';
import { useInviteIssue } from '@/components/admin/invite-issue';

/**
 * Issues a code (C6 spec §4.1, Ruling 17); the code shows in NewInvitePanel under the tabs. No countdown: an invite
 * lives seven days, so a ticking clock would be theatre. Busy is aria-disabled + the guard, so focus stays here.
 */
export function IssueInviteButton() {
  const { setCode } = useInviteIssue();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const working = busy || pending;

  async function onClick() {
    if (busy || pending) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/invites', { method: 'POST' });
      if (!res.ok) {
        toast.error('Could not issue an invite', { description: `The server answered ${res.status}.` });
        return;
      }
      const body = await res.json();
      // One transition: the code shows together with the refreshed list that lists it, and busy holds until then.
      startTransition(() => { setCode(body.code); router.refresh(); });
    } catch {
      toast.error('Could not reach the server', { description: 'Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} aria-disabled={working || undefined}
            className="inline-flex h-[42px] items-center gap-2 rounded-[10px] px-[18px] text-[14px] font-semibold text-white aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
            style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
      <PlusIcon aria-hidden className="size-4" />
      {working ? 'Issuing…' : 'Issue an invite'}
    </button>
  );
}
