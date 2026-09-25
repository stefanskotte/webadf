'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Link } from '@/components/shell/link';
import { NOT_EXTRACTABLE } from '@/lib/hfe/messages';

/**
 * Extract as ADF, or -- when the HFE is not a clean AmigaDOS disk -- the one
 * line saying why not (show-both-values: never a silently absent button).
 */
export function ExtractAction({ diskId, extractable, reason }: {
  diskId: string; extractable: boolean; reason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // The id of an ADF this HFE was extracted to earlier, which has been edited
  // since. Set only from the route's 409 `already_extracted`.
  const [editedId, setEditedId] = useState<string | null>(null);

  if (!extractable) {
    // The reason is VISIBLE, not only a tooltip: a phone or tablet has no
    // hover, so a `title` alone left touch users with "play only" and no
    // why. `title` stays for the pointer case, where the line may be clipped.
    // No shrink-0 and a max width, so a long reason wraps at 390px instead
    // of pushing the row's other controls off the side.
    return (
      <span className="flex min-w-0 max-w-full flex-col gap-0.5 sm:max-w-[240px]"
            title={reason ?? undefined} data-testid={`extract-reason-${diskId}`}>
        <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>{NOT_EXTRACTABLE}</span>
        {reason && (
          <span className="break-words text-[10.5px]" style={{ color: 'var(--muted-2)' }}
                data-testid={`extract-why-${diskId}`}>
            {reason}
          </span>
        )}
      </span>
    );
  }

  async function onExtract() {
    setBusy(true);
    try {
      const res = await fetch(`/api/disks/${diskId}/extract`, { method: 'POST' });
      if (res.status === 409) {
        const body = await res.json().catch(() => null);
        if (body?.error === 'already_extracted' && typeof body.diskId === 'string') {
          setEditedId(body.diskId);
          return;
        }
      }
      if (!res.ok) {
        toast.error('Could not extract', { description: `The server answered ${res.status}.` });
        return;
      }
      setEditedId(null);
      toast.success('Extracted as ADF');
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex min-w-0 max-w-full flex-col gap-1 sm:max-w-[260px]">
      <button type="button" onClick={onExtract} disabled={busy} data-testid={`extract-${diskId}`}
              className="btn-like shrink-0 self-start rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
              style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}>
        Extract as ADF
      </button>
      {/*
        Inline rather than a toast: it carries a link, and it is the answer to
        "why did nothing new appear?" -- which should stay on screen while the
        person decides. Extracting again would make the same ADF, and that
        disk already exists here under the same id; what changed is that
        someone edited it. Its History still holds the extracted bytes as the
        first version, so Restore gets them back without a second copy.
      */}
      {editedId && (
        <span className="break-words text-[11.5px]" style={{ color: 'var(--amber-text)' }}
              role="status" data-testid={`extract-edited-${diskId}`}>
          Already extracted, and that ADF has been edited since.{' '}
          <Link href={`/disks/${editedId}/files#disk-history`} className="font-semibold underline underline-offset-2"
                data-testid={`extract-edited-link-${diskId}`}>
            Open it
          </Link>
          {' '}— its History can restore the original.
        </span>
      )}
    </span>
  );
}
