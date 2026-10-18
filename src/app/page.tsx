import { redirect } from 'next/navigation';
import { requireOrg } from '@/lib/session';
import { getUserPrefs } from '@/lib/user-prefs';
import { startPagePath } from '@/lib/user-prefs-schema';

/**
 * The app has no marketing page -- "/" is just the way in. This used to be the
 * untouched create-next-app scaffold ("edit this page", Next.js/Vercel
 * links), which was the landing page on the live deployment.
 *
 * Signed in, it lands on the person's chosen start page (Preferences on the
 * Settings page; Library unless they changed it). Sign-in itself goes through
 * here too (sign-in/page.tsx), so the two can never disagree. Signed out,
 * requireOrg() bounces to /sign-in, which is where /library sent them before.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const { userId } = await requireOrg();
  const prefs = await getUserPrefs(userId);
  redirect(startPagePath(prefs.startPage));
}
