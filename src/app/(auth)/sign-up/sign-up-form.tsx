'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signUp } from '@/lib/auth-client';
import { authErrorText } from '@/lib/auth-errors';
import {
  AUTH_ERROR, AUTH_ERROR_STYLE, AUTH_FIELD, AUTH_FIELD_STYLE, AUTH_FIELD_WRAP, AUTH_FORM, AUTH_H1, AUTH_HINT, AUTH_LABEL,
  AUTH_SUBMIT, AUTH_SUBMIT_STYLE,
} from '../auth-look';

export function SignUpForm({ initialInviteCode }: { initialInviteCode: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    // The invite code rides along as a plain extra body property -- the
    // server endpoint accepts arbitrary extra fields (see src/lib/auth.ts),
    // but the generated client type for signUp.email doesn't know about
    // this app-specific one, so it has to be spelled out here to avoid an
    // excess-property error on the object literal.
    const body: Parameters<typeof signUp.email>[0] & { inviteCode: string } = {
      email, password, name: email.split('@')[0], inviteCode,
    };
    // A dropped connection rejects instead of returning an error; the button must come back either way.
    let err: Awaited<ReturnType<typeof signUp.email>>['error'];
    try { ({ error: err } = await signUp.email(body)); }
    catch { setError('Could not reach the server. Try again.'); return; }
    finally { setBusy(false); }
    if (err) { setError(authErrorText('up', err)); return; }
    router.push('/library');
  }

  return (
    <form onSubmit={onSubmit} data-testid="sign-up-form" className={AUTH_FORM}>
      <h1 className={AUTH_H1} style={{ color: 'var(--ink)' }}>Create your account</h1>
      {/* Ruling 35: the invite code first (board order), still prefilled from ?invite= on the server. */}
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="invite-code" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Invite code</label>
        <input id="invite-code" type="text" autoComplete="off" spellCheck={false} required value={inviteCode}
               aria-describedby="invite-code-hint" onChange={(e) => setInviteCode(e.target.value)}
               className={`${AUTH_FIELD} font-mono text-[16px] tracking-[0.12em]`} style={AUTH_FIELD_STYLE} />
        <p id="invite-code-hint" className={AUTH_HINT} style={{ color: 'var(--muted-2)' }}>
          Ask the person who runs this server for one. Each code works once.
        </p>
      </div>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="email" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Email</label>
        <input id="email" type="email" autoComplete="email" required value={email}
               onChange={(e) => setEmail(e.target.value)} className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
      </div>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="password" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Password</label>
        <input id="password" type="password" autoComplete="new-password" required minLength={8} value={password}
               aria-describedby="password-hint" onChange={(e) => setPassword(e.target.value)}
               className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
        <p id="password-hint" className={AUTH_HINT} style={{ color: 'var(--muted-2)' }}>At least 8 characters.</p>
      </div>
      {error && <p role="alert" data-testid="auth-error" className={AUTH_ERROR} style={AUTH_ERROR_STYLE}>{error}</p>}
      <button type="submit" aria-disabled={busy} className={AUTH_SUBMIT} style={AUTH_SUBMIT_STYLE}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
}
