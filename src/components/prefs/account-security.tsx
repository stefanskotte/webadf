'use client';

import { useId, useState } from 'react';
import { authClient } from '@/lib/auth-client';

/** better-auth's own minimum, the one sign-up enforces. */
const MIN_PASSWORD = 8;

const field = 'h-8 rounded-lg border px-2 text-[12.5px]';
const fieldStyle = { borderColor: 'var(--hairline)', background: 'var(--input-bg)', color: 'var(--ink)' };
const primary = 'btn-like rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60';

function browsers(n: number) {
  return n <= 1 ? 'Signed in on this browser only' : `Signed in on ${n} browsers`;
}

/**
 * Settings > Sign-in & password (A2): the account's email, Change password, and how many browsers are signed in
 * with "Sign out everywhere else". Both go through better-auth's own endpoints (its router, so its rate limiter
 * applies). A password change also signs out every other browser: a changed password is the usual sign that someone
 * else might have had it.
 */
export function AccountSecurity({ email, sessionCount }: { email: string; sessionCount: number }) {
  const [sessions, setSessions] = useState(sessionCount);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();

  async function revokeOthers() {
    setRevoking(true);
    setRevokeError(null);
    const { error: err } = await authClient.revokeOtherSessions();
    setRevoking(false);
    if (err) setRevokeError("Couldn't sign out the other browsers. Try again.");
    else setSessions(1);
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < MIN_PASSWORD) { setError(`The new password needs at least ${MIN_PASSWORD} characters.`); return; }
    if (next !== confirm) { setError("The new passwords don't match."); return; }
    setBusy(true);
    const { error: err } = await authClient.changePassword({
      currentPassword: current, newPassword: next, revokeOtherSessions: true,
    });
    setBusy(false);
    if (err) {
      setError(err.code === 'INVALID_PASSWORD' ? 'That is not your current password.'
        : err.status === 429 ? 'Too many attempts. Wait a minute and try again.'
          : "Couldn't change the password. Try again.");
      return;
    }
    setOpen(false);
    setCurrent(''); setNext(''); setConfirm('');
    setSessions(1);
    setDone(true);
  }

  return (
    <section className="glass-card flex flex-col gap-4 p-5" data-testid="account-security">
      <h2 className="text-[13px] font-semibold">Sign-in &amp; password</h2>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold" style={{ color: 'var(--muted)' }}>Email</span>
          <span className="font-mono" data-testid="account-email" style={{ color: 'var(--ink)' }}>{email}</span>
        </div>

        {open ? (
          <form onSubmit={(e) => void changePassword(e)} className="flex max-w-[360px] flex-col gap-2" data-testid="password-form">
            <label htmlFor={currentId} className="font-semibold" style={{ color: 'var(--muted)' }}>Current password</label>
            <input id={currentId} type="password" autoComplete="current-password" value={current} required
                   onChange={(e) => setCurrent(e.target.value)} data-testid="password-current" className={field} style={fieldStyle} />
            <label htmlFor={nextId} className="font-semibold" style={{ color: 'var(--muted)' }}>New password</label>
            <input id={nextId} type="password" autoComplete="new-password" value={next} required
                   onChange={(e) => setNext(e.target.value)} data-testid="password-new" className={field} style={fieldStyle} />
            <label htmlFor={confirmId} className="font-semibold" style={{ color: 'var(--muted)' }}>New password again</label>
            <input id={confirmId} type="password" autoComplete="new-password" value={confirm} required
                   onChange={(e) => setConfirm(e.target.value)} data-testid="password-confirm" className={field} style={fieldStyle} />
            <span style={{ color: 'var(--muted)' }}>At least {MIN_PASSWORD} characters. Your other browsers will be signed out.</span>
            {error && <span role="alert" data-testid="password-error" style={{ color: 'var(--danger-fg)' }}>{error}</span>}
            <div className="mt-1 flex items-center gap-3">
              <button type="submit" disabled={busy} data-testid="password-save" className={primary}
                      style={{ background: 'var(--primary-action)' }}>
                {busy ? 'Changing…' : 'Change password'}
              </button>
              <button type="button" onClick={() => { setOpen(false); setError(null); }} className="text-[12.5px] font-semibold"
                      style={{ color: 'var(--muted)' }}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => { setOpen(true); setDone(false); }} data-testid="password-change-open"
                    className="btn-like rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold"
                    style={{ borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}>
              Change password…
            </button>
            {done && (
              <span role="status" data-testid="password-done" style={{ color: 'var(--success-fg)' }}>
                Password changed. Your other browsers were signed out.
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="sessions-count" style={{ color: 'var(--ink)' }}>{browsers(sessions)}</span>
          {sessions > 1 && (
            <button type="button" onClick={() => void revokeOthers()} disabled={revoking} data-testid="sessions-revoke"
                    className="btn-like rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold disabled:opacity-60"
                    style={{ borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }}>
              {revoking ? 'Signing out…' : 'Sign out everywhere else'}
            </button>
          )}
          {revokeError && <span role="alert" style={{ color: 'var(--danger-fg)' }}>{revokeError}</span>}
        </div>
      </div>
    </section>
  );
}
