'use client';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      // The ghost variant's colours are set here for the header.
      data-testid="sign-out"
      className="h-9 rounded-[10px] px-3.5 text-[14px] font-medium text-(--muted) hover:bg-(--track) hover:text-(--ink)"
      onClick={async () => {
        await signOut();
        router.push('/sign-in');
      }}
    >
      Sign out
    </Button>
  );
}
