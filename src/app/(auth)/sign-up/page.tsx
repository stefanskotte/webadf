'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signUp } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    // The invite code rides along as a plain extra body property -- the
    // server endpoint accepts arbitrary extra fields (see src/lib/auth.ts),
    // but the generated client type for signUp.email doesn't know about
    // this app-specific one, so it has to be spelled out here to avoid an
    // excess-property error on the object literal.
    const body: Parameters<typeof signUp.email>[0] & { inviteCode: string } = {
      email, password, name: email.split('@')[0], inviteCode,
    };
    const { error } = await signUp.email(body);
    setBusy(false);
    if (error) { setError(error.message ?? 'Sign up failed'); return; }
    router.push('/library');
  }

  return (
    <form
      onSubmit={onSubmit}
      /* `--glass-strong` (0.80 white) rather than `.glass-card`'s own `--glass`
         (0.62): a panel centred in the viewport lands anywhere on the gradient
         depending on window height, and only the stronger fill keeps `--ink`
         above 10:1 even composited over the darkest stop. */
      style={{ background: 'var(--glass-strong)' }}
      className="glass-card flex w-full max-w-sm flex-col gap-4 p-7"
    >
      <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--ink)' }}>Create your library</h1>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email" style={{ color: 'var(--muted)' }}>Email</Label>
        <Input id="email" type="email" value={email} required
               onChange={(e) => setEmail(e.target.value)}
               style={{ background: 'var(--input-bg)', borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password" style={{ color: 'var(--muted)' }}>Password</Label>
        <Input id="password" type="password" value={password} required minLength={8}
               onChange={(e) => setPassword(e.target.value)}
               style={{ background: 'var(--input-bg)', borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="invite-code" style={{ color: 'var(--muted)' }}>Invite code</Label>
        <Input id="invite-code" type="text" value={inviteCode} required
               onChange={(e) => setInviteCode(e.target.value)}
               style={{ background: 'var(--input-bg)', borderColor: 'var(--hairline-strong)', color: 'var(--ink)' }} />
      </div>
      {error && <p role="alert" className="text-sm font-semibold" style={{ color: 'var(--danger-fg)' }}>{error}</p>}
      <Button type="submit" disabled={busy} style={{ background: 'var(--primary-action)', color: '#fff' }}>
        {busy ? 'Creating…' : 'Sign up'}
      </Button>
    </form>
  );
}
