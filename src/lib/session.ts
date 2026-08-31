import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export async function requireOrg(): Promise<{ userId: string; orgId: string; email: string }> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) redirect('/sign-in');

  // A session with no active organization has nothing this app can show. The
  // previous target, /onboarding, does not exist — every authenticated page
  // hit a hard 404 with no way out. Sending the user back through sign-in is
  // the simplest correct recovery: signing in re-establishes an active org.
  const orgId = result.session.activeOrganizationId;
  if (!orgId) redirect('/sign-in');

  // `email` rides along because the app shell needs it to decide whether to
  // draw the Admin nav link (see isSuperAdminEmail). The session is already
  // loaded here, so returning it costs nothing and saves the layout a second
  // getSession() round trip on every authenticated page render.
  return { userId: result.user.id, orgId, email: result.user.email };
}
