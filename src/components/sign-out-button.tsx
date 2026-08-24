'use client';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      // The ghost variant sets no resting text colour, so it inherited
      // body's --foreground (#223140) -- effectively invisible against the
      // dark top of the page gradient (--grad-top #1b2534, ~1.16:1
      // contrast). Every other header element already overrides explicitly
      // (the wordmark uses --on-dark, TopNav's inactive items use
      // rgb(233 240 244 / .78)); this brings Sign out in line with them,
      // including a legible hover state on the same translucent-white
      // treatment TopNav's pill uses, instead of ghost's default
      // hover:bg-muted + hover:text-foreground (a light bg with dark text
      // would itself be fine, but paired with our forced light resting
      // text it would flip to low contrast on hover).
      className="text-[color:var(--on-dark-muted)] hover:bg-white/10 hover:text-[color:var(--on-dark)]"
      onClick={async () => {
        await signOut();
        router.push('/sign-in');
      }}
    >
      Sign out
    </Button>
  );
}
