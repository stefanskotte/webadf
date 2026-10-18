'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { savePrefs } from '@/lib/user-prefs-client';

/**
 * Settings > Firmware updates: "Don't ask for my password when updating board
 * firmware" (UserPrefs.firmware.skipPassword).
 *
 * Saved on its own, not with the Preferences form's Save, because the two
 * directions differ: turning it ON needs the password (POST
 * /api/me/prefs/firmware-skip-password -- a stolen session must not be able
 * to switch the prompt off), so ticking the box opens a password field in
 * place; turning it OFF saves at once (PATCH /api/me/prefs).
 *
 * The state is said in words beside the box, "Password asked" / "Password not
 * asked", so it never rests on reading a checkbox alone.
 */
export function FirmwarePasswordSetting({ skipPassword }: { skipPassword: boolean }) {
  const router = useRouter();
  const boxId = useId();
  const pwId = useId();
  const warnId = useId();
  const [on, setOn] = useState(skipPassword);
  const [arming, setArming] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function disarm() {
    setArming(false);
    setPassword('');
    setError(null);
  }

  async function turnOff() {
    // Shown off at once (the box answers the click), put back if the save
    // fails, so the words beside the box always end on what is stored.
    setOn(false);
    setBusy(true);
    try {
      await savePrefs({ firmware: { skipPassword: false } });
      toast.success('Firmware updates will ask for your password again.');
      router.refresh();
    } catch {
      setOn(true);
      toast.error("Couldn't save that. Firmware updates still skip the password.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOn() {
    if (busy || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/prefs/firmware-skip-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      // An expired session redirects to /sign-in, which fetch follows to a
      // 200 HTML page; without this it would read as success.
      if (res.redirected || !res.headers.get('content-type')?.includes('application/json')) {
        setError('Your session expired. Sign in again and retry.');
        return;
      }
      if (res.status === 429) {
        const { retryAfterMs } = await res.json();
        const mins = Math.ceil((retryAfterMs ?? 0) / 60000);
        setError(`Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
        return;
      }
      if (res.status === 401) { setError('That password was not right.'); return; }
      if (!res.ok) { setError("Couldn't save that. Nothing was changed."); return; }
      setOn(true);
      disarm();
      toast.success('Firmware updates will no longer ask for your password.');
      router.refresh();
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass-card flex flex-col gap-3 p-5" data-testid="firmware-prefs">
      <h2 className="text-[13px] font-semibold">Firmware updates</h2>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-[13px]">
          <input id={boxId} type="checkbox" data-testid="fw-skip-password" aria-describedby={warnId}
                 checked={on || arming} disabled={busy}
                 onChange={(e) => {
                   if (e.target.checked) { setArming(true); return; }
                   if (arming) { disarm(); return; }
                   void turnOff();
                 }} />
          <label htmlFor={boxId}>Don&apos;t ask for my password when updating board firmware</label>
        </span>
        <span className="text-[12px] font-semibold" data-testid="fw-password-state" role="status" aria-live="polite"
              style={{ color: on ? 'var(--amber-text)' : 'var(--muted)' }}>
          {on ? 'Password not asked' : 'Password asked'}
        </span>
      </div>
      <p id={warnId} className="text-[12px]" style={{ color: 'var(--muted)' }}>
        With this on, anyone using your signed-in browser can update your boards&apos; firmware.
      </p>
      {arming && (
        // A <form>, so Enter in the password field confirms.
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void turnOn(); }}>
          <label htmlFor={pwId} className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--muted)' }}>
            Confirm with your password
            <input id={pwId} type="password" data-testid="fw-skip-password-input" value={password}
                   autoFocus autoComplete="current-password"
                   onChange={(e) => setPassword(e.target.value)}
                   className="rounded-lg px-3 py-2 text-[13px]"
                   style={{ background: 'var(--input-bg)', color: 'var(--ink)' }} />
          </label>
          <button type="submit" data-testid="fw-skip-password-confirm" disabled={busy || password.length === 0}
                  className="btn-like rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  style={{ background: 'var(--primary-action)' }}>
            {busy ? 'Checking…' : 'Turn off the password'}
          </button>
          <button type="button" onClick={disarm} disabled={busy} className="py-2 text-[13px] disabled:opacity-50"
                  style={{ color: 'var(--muted)' }}>Cancel</button>
          {error && (
            <span className="basis-full text-[12px]" data-testid="fw-skip-password-error" role="alert"
                  style={{ color: 'var(--amber-text)' }}>{error}</span>
          )}
        </form>
      )}
    </section>
  );
}
