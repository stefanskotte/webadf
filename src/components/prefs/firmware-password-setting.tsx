'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { savePrefs } from '@/lib/user-prefs-client';
import { CARD_STYLE, FIELD, FIELD_STYLE, INK_BTN, INK_STYLE, OUTLINE_BTN, OUTLINE_STYLE, SETTINGS_CARD, SETTINGS_H2, SETTINGS_ROW } from '@/lib/settings-look';

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
  const labelId = useId();
  const pwId = useId();
  const warnId = useId();
  const [on, setOn] = useState(skipPassword);
  const [arming, setArming] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchRef = useRef<HTMLButtonElement>(null);
  /** Cancel, Escape, and a successful turn-on all close the confirm form: focus goes back to the switch (spec §2.6). */
  function closeConfirm() { disarm(); switchRef.current?.focus(); }
  function onSwitch() {
    if (busy) return;
    if (!on && !arming) { setArming(true); return; }
    if (arming) { closeConfirm(); return; }
    void turnOff();
  }
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
      closeConfirm();
      toast.success('Firmware updates will no longer ask for your password.');
      router.refresh();
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  const checked = on || arming;
  return (
    <section id="firmware" aria-labelledby="firmware-heading" data-testid="firmware-prefs" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className={SETTINGS_ROW}>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h2 id="firmware-heading" tabIndex={-1} className={`${SETTINGS_H2} justify-self-start`} style={{ color: 'var(--ink)' }}>
            Firmware updates
          </h2>
          <span id={labelId} className="text-[14px] font-medium" style={{ color: 'var(--ink)' }}>
            Don&apos;t ask for my password when updating board firmware
          </span>
          <p id={warnId} className="text-[13px]" style={{ color: 'var(--muted-2)' }}>
            With this on, anyone using your signed-in browser can update your boards&apos; firmware.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <span data-testid="fw-password-state" role="status" aria-live="polite" className="text-[12px] font-semibold"
                style={{ color: on ? 'var(--amber-text)' : 'var(--muted)' }}>
            {on ? 'Password not asked' : 'Password asked'}
          </span>
          {/* Ruling 10: on = the password is NOT asked (A2's stored meaning). The off track carries a --muted-2 border
              (5.58:1 on the card) so "off" is visible as well as said. */}
          <button ref={switchRef} type="button" role="switch" aria-checked={checked} aria-labelledby={labelId}
                  aria-describedby={warnId} aria-disabled={busy} data-testid="fw-skip-password" onClick={onSwitch}
                  className="flex h-[26px] w-11 shrink-0 rounded-full border p-[3px] aria-disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
                  style={checked
                    ? { background: 'var(--ink)', borderColor: 'var(--ink)' }
                    : { background: 'var(--line-strong)', borderColor: 'var(--muted-2)' }}>
            <span aria-hidden className={`size-[18px] rounded-full ${checked ? 'ml-auto' : ''}`}
                  style={{ background: 'var(--surface)', boxShadow: '0 1px 2px rgb(0 0 0 / .25)' }} />
          </button>
        </div>
        {arming && (
          // A <form>, so Enter in the password field confirms.
          <form className="col-span-full flex flex-wrap items-end gap-2.5"
                onSubmit={(e) => { e.preventDefault(); void turnOn(); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); } }}>
            <label htmlFor={pwId} className="flex flex-col gap-1.5 text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
              Confirm with your password
              <input id={pwId} type="password" data-testid="fw-skip-password-input" value={password}
                     autoFocus autoComplete="current-password"
                     onChange={(e) => setPassword(e.target.value)} className={`${FIELD} sm:w-[260px]`} style={FIELD_STYLE} />
            </label>
            <button type="submit" data-testid="fw-skip-password-confirm" aria-disabled={busy || password.length === 0}
                    className={INK_BTN} style={INK_STYLE}>
              {busy ? 'Checking…' : 'Turn off the password'}
            </button>
            <button type="button" onClick={closeConfirm} className={OUTLINE_BTN} style={OUTLINE_STYLE}>Cancel</button>
            {error && (
              <span className="basis-full text-[13px]" data-testid="fw-skip-password-error" role="alert"
                    style={{ color: 'var(--danger-fg)' }}>{error}</span>
            )}
          </form>
        )}
      </div>
    </section>
  );
}
