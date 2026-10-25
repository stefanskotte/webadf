'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/modal';
import { looksLikeTestBuild } from '@/lib/admin-firmware';
import { pageHeading } from '@/components/admin/page-heading';

/**
 * Promote a TEST build to a release (A7 spec §3; C6 spec §6.5 on the shared Modal): the notes with "TEST build"
 * removed, editable; Promote saves them through POST /api/admin/firmware/[id]/promote.
 *
 * Rendered on EVERY row, with `canPromote` saying whether the trigger shows: after a promote, router.refresh()
 * re-renders the row as a Release, and were the component rendered only on Test rows it would unmount right then and
 * the done text (the GitHub step the operator still has to run) would vanish before anyone read it.
 * `refreshOnDone` is false under the Test builds filter, where the refreshed list no longer holds the row at all:
 * the refresh then waits until the dialog closes.
 */
export function PromoteReleaseButton({
  id, version, initialNotes, canPromote, refreshOnDone,
}: {
  id: string; version: string; initialNotes: string; canPromote: boolean; refreshOnDone: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  // The row stops being a Test build (promoted, or a 409 says it already was): its trigger goes, so the h1 takes focus.
  const gone = useRef(false);
  // A refresh still owed because refreshOnDone was false.
  const owed = useRef(false);

  useEffect(() => { if (done) closeBtn.current?.focus(); }, [done]);

  const trimmed = notes.trim();
  const armed = trimmed.length > 0 && trimmed.length <= 2000 && !looksLikeTestBuild(trimmed);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setError(null);
      setDone(false);
      if (owed.current) { owed.current = false; router.refresh(); }
    }
  }

  function finalFocus(): HTMLElement | null {
    if (gone.current) return pageHeading();
    return trigger.current && document.contains(trigger.current) ? trigger.current : pageHeading();
  }

  function refresh() {
    if (refreshOnDone) router.refresh(); else owed.current = true;
  }

  async function onPromote() {
    if (busy || !armed) return;
    setBusy(true);
    setError(null);
    try {
      // redirect: 'manual' -- a signed-out session is answered with requireSuperAdmin()'s redirect to /sign-in, and
      // a followed redirect is a 200 HTML page that must never read as "Promoted".
      const res = await fetch(`/api/admin/firmware/${id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notes }),
        redirect: 'manual',
      });
      if (res.type === 'opaqueredirect' || res.redirected || res.status === 401 || res.status === 403) {
        setError(SIGNED_OUT);
        return;
      }
      const body = (await res.json().catch(() => null)) as { id?: string; error?: string; reason?: string } | null;
      if (res.ok) {
        // Done only for the row's own JSON: anything else (an HTML page, an empty body) is not a promote.
        if (body?.id !== id) { setError(SIGNED_OUT); return; }
        gone.current = true;
        setDone(true);
        refresh();
        return;
      }
      setError(errorText(res.status, body));
      if (res.status === 409 && body?.error === 'not_test_build') { gone.current = true; refresh(); }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const OUTLINE = 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-4 text-[13px] font-semibold text-(--ink) hover:bg-(--track) aria-disabled:opacity-60';

  return (
    <>
      {canPromote && (
        <button
          ref={trigger}
          type="button"
          onClick={() => { setNotes(initialNotes); gone.current = false; setOpen(true); }}
          data-testid={`fw-promote-${id}`}
          className="h-8 rounded-[8px] border border-(--line) px-2.5 text-[13px] font-medium text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
        >
          Promote to release…
        </button>
      )}
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        width={620}
        testId="fw-promote-dialog"
        closeTestId="fw-promote-close"
        title="Promote to release"
        subtitle={<span className="font-mono [overflow-wrap:anywhere]">{version}</span>}
        dismissible={!busy}
        initialFocus={field}
        finalFocus={finalFocus}
        footer={done ? (
          <div className="flex w-full justify-end">
            <button ref={closeBtn} type="button" data-testid="fw-promote-done-close" onClick={() => onOpenChange(false)} className={OUTLINE}>
              Close
            </button>
          </div>
        ) : (
          <div className="flex w-full items-center justify-end gap-2.5">
            <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) onOpenChange(false); }} className={OUTLINE}>
              Cancel
            </button>
            {/* Native disabled is the notes gate (not focused while not armed); busy is aria-disabled + the guard. */}
            <button type="button" onClick={onPromote} disabled={!armed} aria-disabled={busy || undefined}
                    data-testid="fw-promote-confirm"
                    className="h-[38px] rounded-[10px] px-4 text-[13px] font-semibold text-white disabled:opacity-50 aria-disabled:opacity-60"
                    style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
              {busy ? 'Promoting…' : 'Promote'}
            </button>
          </div>
        )}
      >
        {done ? (
          <p className="px-6 py-5 text-[14px]" style={{ color: 'var(--ink)' }} data-testid="fw-promote-done">
            Promoted. The GitHub release is made from the build folder: run{' '}
            <code className="font-mono">pnpm firmware:publish --github-only</code>.
          </p>
        ) : (
          <div className="flex flex-col gap-3 px-6 py-5">
            <p className="text-[14px]" style={{ color: 'var(--muted)' }} data-testid="fw-promote-scope">
              Every organization&apos;s boards will be offered this build.
            </p>
            <label htmlFor={`fw-notes-${id}`} className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              Release notes
            </label>
            <textarea
              ref={field}
              id={`fw-notes-${id}`}
              data-testid="fw-promote-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={5}
              maxLength={2000}
              className="-mt-2 rounded-[10px] px-3 py-2 text-[14px]"
              style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' }}
            />
            {error && (
              <p role="alert" className="text-[13px]" style={{ color: 'var(--danger-fg)' }} data-testid="fw-promote-error">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

const SIGNED_OUT = 'Signed out — sign in again';

function errorText(status: number, body: { error?: string; reason?: string } | null): string {
  switch (body?.error) {
    case 'invalid_notes': return 'Notes must be 1 to 2000 characters.';
    case 'still_test_build': return 'Notes must not start with "TEST build" (in any case).';
    case 'image_mismatch': return 'The stored image does not match the release\'s sha256; it cannot be promoted.';
    case 'not_found': return 'This release no longer exists.';
    case 'not_test_build': return 'This release is no longer a TEST build; it was already promoted.';
    case 'bench_image': return `This image is a bench-only build and cannot be a release: ${body.reason}`;
    case 'image_too_large': return 'The stored image is over the 2 MB limit.';
    case 'blob_unavailable': return 'The image could not be read from storage. Try again.';
    default: return `Could not promote: the server answered ${status}.`;
  }
}
