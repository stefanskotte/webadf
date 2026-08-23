import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export async function requireOrg(): Promise<{ userId: string; orgId: string }> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) redirect('/sign-in');

  const orgId = result.session.activeOrganizationId;
  if (!orgId) redirect('/onboarding');

  return { userId: result.user.id, orgId };
}
