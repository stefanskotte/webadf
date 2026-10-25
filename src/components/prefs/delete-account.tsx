'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CARD_STYLE, FIELD, FIELD_STYLE, OUTLINE_BTN, OUTLINE_STYLE, SETTINGS_CARD, SETTINGS_H2, SETTINGS_ROW } from '@/lib/settings-look';

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

  const openerRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!open && refocus.current) { refocus.current = false; openerRef.current?.focus(); }
  }, [open]);
  function close() { refocus.current = true; setOpen(false); setPassword(''); setConfirm(''); setError(null); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
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
    <section id="danger" aria-labelledby="danger-heading" data-testid="delete-account" className={SETTINGS_CARD}
             style={{ ...CARD_STYLE, boxShadow: '0 0 0 1px var(--danger-line)' }}>
      <div className={SETTINGS_ROW}>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h2 id="danger-heading" tabIndex={-1} className={`${SETTINGS_H2} justify-self-start`} style={{ color: 'var(--danger-strong)' }}>
            Delete account
          </h2>
          <p className="text-[13px]" style={{ color: 'var(--muted-2)' }}>
            Removes your library, boards and uploads. Paired boards go back to setup mode. This cannot be undone.
          </p>
        </div>
        {!open && (
          <button ref={openerRef} type="button" onClick={() => setOpen(true)} data-testid="account-delete-open"
                  className="h-[38px] justify-self-start rounded-[10px] border px-3.5 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
                  style={{ background: 'var(--surface)', borderColor: 'var(--danger-line)', color: 'var(--danger-fg)' }}>
            Delete account…
          </button>
        )}
        {open && (
          <form onSubmit={(e) => void submit(e)} className="col-span-full flex max-w-[400px] flex-col gap-2.5"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
            <label htmlFor={pwId} className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>Your password</label>
            <input id={pwId} type="password" autoComplete="current-password" value={password} autoFocus
                   onChange={(e) => setPassword(e.target.value)} data-testid="account-delete-password" className={FIELD} style={FIELD_STYLE} />
            <label htmlFor={confirmId} className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>Type DELETE to confirm</label>
            <input id={confirmId} type="text" autoComplete="off" spellCheck={false} value={confirm}
                   onChange={(e) => setConfirm(e.target.value)} data-testid="account-delete-confirm"
                   className={`${FIELD} font-mono`} style={FIELD_STYLE} />
            {error && <span role="alert" data-testid="account-delete-error" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{error}</span>}
            <div className="flex items-center gap-2.5">
              <button type="submit" disabled={!ready} aria-disabled={busy} data-testid="account-delete-submit"
                      className="h-9 rounded-[9px] px-3.5 text-[13px] font-semibold text-white disabled:opacity-50 aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
                      style={{ background: 'var(--danger-fg)', color: '#FFFFFF' }}>
                {busy ? 'Deleting…' : 'Delete my account'}
              </button>
              <button type="button" onClick={close} className={OUTLINE_BTN} style={OUTLINE_STYLE}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
