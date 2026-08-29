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
    <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-sm flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold tracking-tight">Create your library</h1>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} required
               onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" value={password} required minLength={8}
               onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="invite-code">Invite code</Label>
        <Input id="invite-code" type="text" value={inviteCode} required
               onChange={(e) => setInviteCode(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Sign up'}</Button>
    </form>
  );
}
