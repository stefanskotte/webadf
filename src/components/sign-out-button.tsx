'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

/**
 * Sign out, for the header button (from lg) and the More menu's item (below lg): one flow, the same words. The
 * request sits in try/catch/finally with an in-flight guard, so a dropped connection says so and never leaves the
 * control busy (Plan ruling, C7 Task 1: the failure toast is new).
 */
export function useSignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await signOut();
      router.push('/sign-in');
    } catch {
      toast.error('Could not sign out', { description: 'Check the connection and try again.' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}

export function SignOutButton() {
  const s = useSignOut();
  return (
    <Button
      variant="ghost"
      // The ghost variant's colours are set here for the header.
      data-testid="sign-out"
      aria-disabled={s.busy || undefined}
      className="h-9 rounded-[10px] px-3.5 text-[14px] font-medium text-(--muted) hover:bg-(--track) hover:text-(--ink)"
      onClick={() => void s.run()}
    >
      Sign out
    </Button>
  );
}
