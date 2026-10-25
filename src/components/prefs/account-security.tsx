'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { CARD_STYLE, FIELD, FIELD_STYLE, INK_BTN, INK_STYLE, OUTLINE_BTN, OUTLINE_STYLE, SETTINGS_CARD, SETTINGS_H2 } from '@/lib/settings-look';

/** better-auth's own minimum, the one sign-up enforces. */
const MIN_PASSWORD = 8;

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

  const openerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The form replaces its opener; when it closes, the opener comes back and takes focus (spec §2.6).
  const refocus = useRef(false);
  useEffect(() => {
    if (!open && refocus.current) { refocus.current = false; openerRef.current?.focus(); }
  }, [open]);

  function closeForm() { refocus.current = true; setOpen(false); setError(null); }

  async function revokeOthers() {
    if (revoking) return;
    setRevoking(true);
    setRevokeError(null);
    const { error: err } = await authClient.revokeOtherSessions();
    setRevoking(false);
    if (err) { setRevokeError("Couldn't sign out the other browsers. Try again."); return; }
    setSessions(1);
    headingRef.current?.focus();   // the focused button is about to go
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
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
    setCurrent(''); setNext(''); setConfirm('');
    setSessions(1);
    setDone(true);
    refocus.current = true;
    setOpen(false);
  }

  const label = 'text-[13px] font-medium';
  return (
    <section id="account" aria-labelledby="account-heading" data-testid="account-security" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="grid grid-cols-1 items-center gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <h2 id="account-heading" ref={headingRef} tabIndex={-1} className={`${SETTINGS_H2} col-span-full mb-1.5 justify-self-start`}
            style={{ color: 'var(--ink)' }}>
          Sign-in &amp; password
        </h2>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }}>Email</span>
          <span data-testid="account-email" className="text-[14px] font-medium" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{email}</span>
        </div>
        {!open && (
          <button ref={openerRef} type="button" onClick={() => { setOpen(true); setDone(false); }}
                  data-testid="password-change-open" className={OUTLINE_BTN} style={OUTLINE_STYLE}>
            Change password…
          </button>
        )}
        {done && !open && (
          <span role="status" data-testid="password-done" className="col-span-full text-[13px]" style={{ color: 'var(--success-fg)' }}>
            Password changed. Your other browsers were signed out.
          </span>
        )}
        {open && (
          <form onSubmit={(e) => void changePassword(e)} data-testid="password-form"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeForm(); } }}
                className="col-span-full flex max-w-[400px] flex-col gap-2.5">
            <label htmlFor={currentId} className={label} style={{ color: 'var(--ink)' }}>Current password</label>
            <input id={currentId} type="password" autoComplete="current-password" value={current} required autoFocus
                   onChange={(e) => setCurrent(e.target.value)} data-testid="password-current" className={FIELD} style={FIELD_STYLE} />
            <label htmlFor={nextId} className={label} style={{ color: 'var(--ink)' }}>New password</label>
            <input id={nextId} type="password" autoComplete="new-password" value={next} required
                   onChange={(e) => setNext(e.target.value)} data-testid="password-new" className={FIELD} style={FIELD_STYLE} />
            <label htmlFor={confirmId} className={label} style={{ color: 'var(--ink)' }}>New password again</label>
            <input id={confirmId} type="password" autoComplete="new-password" value={confirm} required
                   onChange={(e) => setConfirm(e.target.value)} data-testid="password-confirm" className={FIELD} style={FIELD_STYLE} />
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
              At least {MIN_PASSWORD} characters. Your other browsers will be signed out.
            </span>
            {error && <span role="alert" data-testid="password-error" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</span>}
            <div className="flex items-center gap-2.5">
              <button type="submit" aria-disabled={busy} data-testid="password-save" className={INK_BTN} style={INK_STYLE}>
                {busy ? 'Changing…' : 'Change password'}
              </button>
              <button type="button" onClick={closeForm} className={OUTLINE_BTN} style={OUTLINE_STYLE}>Cancel</button>
            </div>
          </form>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }}>Browsers</span>
          <span data-testid="sessions-count" className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>{browsers(sessions)}</span>
        </div>
        {sessions > 1 && (
          <button type="button" onClick={() => void revokeOthers()} aria-disabled={revoking} data-testid="sessions-revoke"
                  className={OUTLINE_BTN} style={OUTLINE_STYLE}>
            {revoking ? 'Signing out…' : 'Sign out everywhere else'}
          </button>
        )}
        {revokeError && (
          <span role="alert" className="col-span-full text-[13px]" style={{ color: 'var(--danger-fg)' }}>{revokeError}</span>
        )}
      </div>
    </section>
  );
}
