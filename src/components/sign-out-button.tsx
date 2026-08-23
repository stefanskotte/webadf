'use client';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button variant="ghost" onClick={async () => {
      await signOut();
      router.push('/sign-in');
    }}>Sign out</Button>
  );
}
