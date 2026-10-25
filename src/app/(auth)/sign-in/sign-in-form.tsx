'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth-client';
import { authErrorText } from '@/lib/auth-errors';
import {
  AUTH_ERROR, AUTH_ERROR_STYLE, AUTH_FIELD, AUTH_FIELD_STYLE, AUTH_FIELD_WRAP, AUTH_FORM, AUTH_H1, AUTH_LABEL, AUTH_SUBMIT,
  AUTH_SUBMIT_STYLE,
} from '../auth-look';

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const { error: err } = await signIn.email({ email, password });
    setBusy(false);
    if (err) { setError(authErrorText('in', err)); return; }
    // "/" sends the person to their chosen start page (src/app/page.tsx).
    router.push('/');
  }

  return (
    <form onSubmit={onSubmit} data-testid="sign-in-form" className={AUTH_FORM}>
      <h1 className={AUTH_H1} style={{ color: 'var(--ink)' }}>Welcome back</h1>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="email" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Email</label>
        <input id="email" type="email" autoComplete="email" required value={email}
               onChange={(e) => setEmail(e.target.value)} className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
      </div>
      <div className={AUTH_FIELD_WRAP}>
        <label htmlFor="password" className={AUTH_LABEL} style={{ color: 'var(--ink)' }}>Password</label>
        <input id="password" type="password" autoComplete="current-password" required minLength={8} value={password}
               onChange={(e) => setPassword(e.target.value)} className={AUTH_FIELD} style={AUTH_FIELD_STYLE} />
      </div>
      {error && <p role="alert" data-testid="auth-error" className={AUTH_ERROR} style={AUTH_ERROR_STYLE}>{error}</p>}
      <button type="submit" aria-disabled={busy} className={AUTH_SUBMIT} style={AUTH_SUBMIT_STYLE}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
