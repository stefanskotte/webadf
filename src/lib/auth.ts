import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { member } from '@/db/schema/auth';

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: 'pg', schemaName: 'auth' }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        // Not atomic with user creation — it runs after the transaction commits.
        // A failure here leaves a user with no org; requireOrg() treats that as
        // "needs onboarding" rather than crashing.
        after: async (user) => {
          await auth.api.createOrganization({
            body: {
              name: `${user.name || user.email.split('@')[0]}'s library`,
              slug: `org-${user.id.slice(0, 12)}`,
              userId: user.id,
            },
            // NO headers — passing them makes the API ignore userId entirely.
          });
        },
      },
    },
    session: {
      create: {
        // createOrganization only sets an org active when a session exists,
        // and none did above. So stamp it onto the session as it is created.
        before: async (session) => {
          const rows = await getDb()
            .select({ organizationId: member.organizationId })
            .from(member)
            .where(eq(member.userId, session.userId))
            .limit(1);
          return { data: { ...session, activeOrganizationId: rows[0]?.organizationId } };
        },
      },
    },
  },
  plugins: [organization(), nextCookies()], // nextCookies LAST
});
