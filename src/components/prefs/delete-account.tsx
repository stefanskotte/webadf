'use client';

import { useId, useState } from 'react';

const field = 'h-8 rounded-lg border px-2 text-[12.5px]';
const fieldStyle = { borderColor: 'var(--hairline)', background: 'var(--input-bg)', color: 'var(--ink)' };

const ERRORS: Record<string, string> = {
  bad_password: 'That is not your password.',
  too_many_attempts: 'Too many wrong passwords. Wait a while and try again.',
  shared_organization: 'Someone else shares this library, so it cannot be deleted from here.',
};

/**
 * Settings > Delete account (A2): DELETE /api/me/account with the password and DELETE typed out. On success the
 * sessions are gone with the user, so this leaves with a full page load to the sign-in page rather than a client
 * navigation that would try to render the app for a user who no longer exists.
 */
export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pwId = useId();
  const confirmId = useId();
  const ready = password.length > 0 && confirm === 'DELETE';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/account', {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, confirm }),
      });
      if (res.ok) {
        // A full load on purpose: see the comment above. A router push would render the app shell for a deleted user.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign('/sign-in');
        return;
      }
      const body = await res.json().catch(() => ({})) as { error?: string };
      setError(ERRORS[body.error ?? ''] ?? "Couldn't delete the account. Nothing was removed. Try again.");
    } catch {
      setError("Couldn't delete the account. Nothing was removed. Try again.");
    }
    setBusy(false);
  }

  return (
    <section className="glass-card flex flex-col gap-3 p-5" data-testid="delete-account">
      <div>
        <h2 className="text-[13px] font-semibold">Delete account</h2>
        <p className="text-[12.5px]" style={{ color: 'var(--muted)' }}>
          Removes your library, boards and uploads. Paired boards go back to setup mode. This cannot be undone.
        </p>
      </div>
      {open ? (
        <form onSubmit={(e) => void submit(e)} className="flex max-w-[360px] flex-col gap-2 text-[12.5px]">
          <label htmlFor={pwId} className="font-semibold" style={{ color: 'var(--muted)' }}>Your password</label>
          <input id={pwId} type="password" autoComplete="current-password" value={password}
                 onChange={(e) => setPassword(e.target.value)} data-testid="account-delete-password" className={field} style={fieldStyle} />
          <label htmlFor={confirmId} className="font-semibold" style={{ color: 'var(--muted)' }}>Type DELETE to confirm</label>
          <input id={confirmId} type="text" autoComplete="off" spellCheck={false} value={confirm}
                 onChange={(e) => setConfirm(e.target.value)} data-testid="account-delete-confirm" className={field} style={fieldStyle} />
          {error && <span role="alert" data-testid="account-delete-error" style={{ color: 'var(--danger-fg)' }}>{error}</span>}
          <div className="mt-1 flex items-center gap-3">
            <button type="submit" disabled={!ready || busy} data-testid="account-delete-submit"
                    className="btn-like rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    style={{ background: 'var(--danger-fg)' }}>
              {busy ? 'Deleting…' : 'Delete my account'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setPassword(''); setConfirm(''); setError(null); }}
                    className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>
          <button type="button" onClick={() => setOpen(true)} data-testid="account-delete-open"
                  className="btn-like rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold"
                  style={{ borderColor: 'var(--danger-fg)', color: 'var(--danger-fg)' }}>
            Delete account…
          </button>
        </div>
      )}
    </section>
  );
}
