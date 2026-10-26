'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';

const BTN = 'h-[38px] rounded-[10px] px-4 text-[13px] font-semibold';

/**
 * An admin gives another account a new password (operator 2026-10-26), on the shared centred Modal like Delete…, for
 * the same wrong-row reason (delete-user-dialog.tsx).
 *
 * Two steps in one dialog. First the ADMIN types their own current password -- the server's step-up gate, so a stolen
 * admin cookie cannot take over accounts. Then the generated password is shown once, with Copy: the server keeps only
 * its hash, so closing the dialog is the last chance to read it.
 *
 * `isSelf` (decided on the server) gets an aria-disabled trigger: your own password is Settings › Account, which asks
 * for the current one. The route's 409 stays as the backstop.
 */
export function ResetPasswordDialog({ userId, email, isSelf }: { userId: string; email: string; isSelf: boolean }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) { setPassword(''); setError(null); setIssued(null); }
  }

  async function onReset() {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      // An expired session redirects to /sign-in, which fetch follows to a 200 HTML page.
      if (res.redirected || !res.headers.get('content-type')?.includes('application/json')) {
        setError('Your session expired. Sign in again and retry.');
        return;
      }
      const body = await res.json() as { password?: string; error?: string; retryAfterMs?: number };
      if (res.status === 429) {
        const mins = Math.max(1, Math.ceil((body.retryAfterMs ?? 0) / 60000));
        setError(`Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
        return;
      }
      if (res.status === 401) { setError('That is not your password. Nothing was changed.'); return; }
      if (res.status === 404) { setError('That account no longer exists.'); return; }
      if (body.error === 'no_password') { setError('That account has no password to reset.'); return; }
      if (body.error === 'self') { setError('Change your own password in Settings › Account.'); return; }
      if (!res.ok || !body.password) { setError(`Could not reset the password. The server answered ${res.status}.`); return; }
      setPassword('');
      setIssued(body.password);
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      toast.success('Password copied');
    } catch {
      toast.error('Could not copy', { description: 'The browser refused clipboard access. Select the password instead.' });
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid={`reset-password-${email}`}
        aria-label={`Reset the password of ${email}`}
        aria-disabled={isSelf ? 'true' : undefined}
        title={isSelf ? 'Change your own password in Settings › Account' : undefined}
        onClick={() => { if (!isSelf) setOpen(true); }}
        className="h-[34px] max-sm:min-h-11 rounded-[9px] px-3 text-[13px] font-medium text-(--ink) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) aria-disabled:cursor-default aria-disabled:text-(--muted-2) aria-disabled:hover:bg-transparent"
      >
        Password…
      </button>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        width={440}
        testId="reset-password-dialog"
        closeTestId="reset-password-close"
        title={issued ? 'New password' : 'Reset this password?'}
        subtitle={<span className="font-mono [overflow-wrap:anywhere]">{email}</span>}
        dismissible={!busy}
        initialFocus={field}
        finalFocus={trigger}
        footer={issued ? (
          <div className="flex w-full items-center justify-end gap-2.5">
            <button type="button" onClick={() => onOpenChange(false)}
                    className={`${BTN} text-(--surface)`} style={{ background: 'var(--ink)' }}>
              Done
            </button>
          </div>
        ) : (
          <div className="flex w-full items-center justify-end gap-2.5">
            <button type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) onOpenChange(false); }}
                    className={`${BTN} border border-(--line) bg-(--surface) text-(--ink) hover:bg-(--track) aria-disabled:opacity-60`}>
              Cancel
            </button>
            <button type="submit" form={`reset-${userId}`} disabled={!password} aria-disabled={busy || undefined}
                    data-testid="reset-password-confirm"
                    className={`${BTN} text-(--surface) disabled:opacity-50 aria-disabled:opacity-60`} style={{ background: 'var(--ink)' }}>
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </div>
        )}
      >
        {issued ? (
          <div className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--muted)' }}>
            <p>
              Give this password to <strong>{email}</strong>. It is shown only now. They have been signed out
              everywhere, and can choose their own in Settings › Account.
            </p>
            <div className="flex items-center gap-2">
              <output data-testid="reset-password-value"
                      className="min-w-0 flex-1 select-all rounded-[10px] px-3 py-2 font-mono text-[15px] [overflow-wrap:anywhere]"
                      style={{ background: 'var(--surface-2)', color: 'var(--ink)', border: '1px solid var(--line)' }}>
                {issued}
              </output>
              <button type="button" onClick={onCopy}
                      className={`${BTN} border border-(--line) bg-(--surface) text-(--ink) hover:bg-(--track)`}>
                Copy
              </button>
            </div>
          </div>
        ) : (
          <form id={`reset-${userId}`} onSubmit={(e) => { e.preventDefault(); void onReset(); }}
                className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--muted)' }}>
            <p>
              A new password is made for <strong>{email}</strong> and shown to you once. Their current password stops
              working and they are signed out everywhere.
            </p>
            <label htmlFor={`admin-pw-${userId}`} className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              Your password
            </label>
            <input
              ref={field}
              id={`admin-pw-${userId}`}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? `admin-pw-err-${userId}` : undefined}
              className="-mt-2 h-10 rounded-[10px] px-3 text-[14px]"
              style={{ background: 'var(--surface)', border: '1px solid var(--line)', color: 'var(--ink)' }}
            />
            {error && (
              <p id={`admin-pw-err-${userId}`} role="alert" data-testid="reset-password-error"
                 className="-mt-1 text-[13px]" style={{ color: 'var(--danger-fg)' }}>
                {error}
              </p>
            )}
          </form>
        )}
      </Modal>
    </>
  );
}
