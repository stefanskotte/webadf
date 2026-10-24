'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Promote a TEST build to a release (A7 spec §3): a centered modal holding the notes with "TEST build" removed,
 * editable; Promote saves them through POST /api/admin/firmware/[id]/promote.
 *
 * Rendered on EVERY row, with `canPromote` saying whether the trigger shows. After a promote, router.refresh()
 * re-renders the row as a Release; were the component rendered only on Test rows it would unmount right then and the
 * done text (the GitHub step the operator still has to run) would vanish before anyone read it.
 */
export function PromoteReleaseButton({
  id, version, initialNotes, canPromote,
}: {
  id: string; version: string; initialNotes: string; canPromote: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const router = useRouter();

  function close() {
    setOpen(false);
    setError(null);
    setDone(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setError(null); setDone(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function onPromote() {
    setBusy(true);
    setError(null);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/admin/firmware/${id}/promote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notes }),
        });
      } catch {
        setError('Could not reach the server. Check your connection and try again.');
        return;
      }
      if (res.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
      setError(errorText(res.status, body));
      if (res.status === 409 && body?.error === 'not_test_build') router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const trimmed = notes.trim();
  const armed = trimmed.length > 0 && trimmed.length <= 2000 && !trimmed.startsWith('TEST build');

  return (
    <>
      {canPromote && (
        <button
          type="button"
          onClick={() => { setNotes(initialNotes); setOpen(true); }}
          data-testid={`fw-promote-${id}`}
          className="self-start text-[12.5px] font-semibold"
          style={{ color: 'var(--accent-blue)' }}
        >
          Promote to release
        </button>
      )}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgb(0 0 0 / 0.45)' }}
          onClick={close}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Promote ${version} to release`}
            data-testid="fw-promote-dialog"
            className="glass-card w-full max-w-[520px] p-6 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-[18px] font-bold tracking-[-0.02em]">Promote to release</h2>
            <p className="mt-1 break-all font-mono text-[12.5px]" style={{ color: 'var(--muted)' }}>{version}</p>
            {done ? (
              <>
                <p className="mt-4 text-[13px]" data-testid="fw-promote-done">
                  Promoted. The GitHub release is made from the build folder: run{' '}
                  <code>pnpm firmware:publish --github-only</code>.
                </p>
                <div className="mt-4 flex justify-end">
                  <button type="button" onClick={close} className="text-[13px] font-medium" style={{ color: 'var(--muted)' }}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor={`fw-notes-${id}`} className="mt-4 block text-[12.5px] font-semibold">
                  Release notes
                </label>
                <textarea
                  id={`fw-notes-${id}`}
                  data-testid="fw-promote-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={5}
                  maxLength={2000}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-[13px]"
                  style={{ borderColor: 'rgb(0 0 0 / 0.18)' }}
                />
                {error && (
                  <p className="mt-2 text-[12.5px]" style={{ color: 'var(--amber-text)' }} data-testid="fw-promote-error">
                    {error}
                  </p>
                )}
                <div className="mt-4 flex items-center justify-end gap-3">
                  <button type="button" onClick={close} className="text-[13px] font-medium" style={{ color: 'var(--muted)' }}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onPromote}
                    disabled={!armed || busy}
                    data-testid="fw-promote-confirm"
                    className="h-[34px] rounded-full px-4 text-[13px] font-semibold disabled:opacity-40"
                    style={{ background: 'var(--primary-action)', color: '#fff' }}
                  >
                    {busy ? 'Promoting…' : 'Promote'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function errorText(status: number, body: { error?: string; reason?: string } | null): string {
  switch (body?.error) {
    case 'invalid_notes': return 'Notes must be 1 to 2000 characters.';
    case 'still_test_build': return 'Notes must not start with "TEST build".';
    case 'not_found': return 'This release no longer exists.';
    case 'not_test_build': return 'This release is no longer a TEST build; it was already promoted.';
    case 'bench_image': return `This image is a bench-only build and cannot be a release: ${body.reason}`;
    case 'image_too_large': return 'The stored image is over the 2 MB limit.';
    case 'blob_unavailable': return 'The image could not be read from storage. Try again.';
    default: return `Could not promote: the server answered ${status}.`;
  }
}
