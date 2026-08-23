import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { isAPIError } from 'better-auth/api';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { member, user as userTable } from '@/db/schema/auth';

// Creates the tenant organization for `userId` and returns its id.
// Called with NO session headers — passing them makes the createOrganization
// API silently ignore `userId` and require an authenticated session instead.
async function bootstrapOrganization(userId: string, name: string): Promise<string> {
  const org = await auth.api.createOrganization({
    body: {
      name,
      // Full user id, not a truncated prefix. A truncated slug collides
      // more easily against the UNIQUE organization.slug column, and a
      // slug collision is exactly the kind of transient error that used to
      // brick sign-up outright (see the comment on user.create.after below).
      slug: `org-${userId}`,
      userId,
    },
  });
  return org.id;
}

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: 'pg', schemaName: 'auth' }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    // Verified empirically against better-auth 1.7.1, not just assumed from
    // reading the types: on sign-up, `signUpEmail` wraps its ENTIRE handler
    // body (createUser, linkAccount, createSession — everything) in
    // `runWithTransaction`, which sets an AsyncLocalStorage
    // `isTransactionActive` flag for that whole span regardless of the
    // drizzle adapter's own `transaction` option above. `user.create.after`
    // runs through `queueAfterTransactionHook`, which checks that same flag:
    // because it's true for the whole request, the hook is queued rather
    // than run inline, and only flushed once the entire handler — including
    // `createSession`, and therefore `session.create.before` below — has
    // already finished. So on essentially every real sign-up,
    // `session.create.before`'s self-heal is what actually creates the
    // organization, and `user.create.after`'s own attempt runs afterward and
    // (harmlessly) collides with it on the shared deterministic slug —
    // expected, not a bug. Both hooks handle that race explicitly below, and
    // both are still required: whichever one runs first does the real
    // bootstrap; the other becomes a no-op once it does.
    user: {
      create: {
        after: async (user) => {
          // Not atomic with user creation — this runs after the transaction
          // that created `user` has already committed, and (per better-auth's
          // sign-up route) *before* the `account` row holding the password
          // credential is linked. better-auth never supplies
          // `onAfterCommitHookError` and does not roll back on an after-hook
          // throw, so letting a genuine failure here throw would propagate
          // out of sign-up while leaving behind a `user` row with no
          // credential — an account nobody can ever sign into again.
          // Swallow and log instead; session.create.before creates the
          // organization lazily if this attempt never ran, failed, or (the
          // common case) already lost the race to it.
          try {
            await bootstrapOrganization(user.id, `${user.name || user.email.split('@')[0]}'s library`);
          } catch (err) {
            if (isAPIError(err) && err.body?.code === 'ORGANIZATION_ALREADY_EXISTS') return;
            console.error(`[auth] failed to bootstrap organization for user ${user.id} (${user.email})`, err);
          }
        },
      },
    },
    session: {
      create: {
        // createOrganization only sets an org active when a session exists,
        // and none did above. So stamp it onto the session as it is created.
        before: async (session) => {
          const db = getDb();
          const rows = await db
            .select({ organizationId: member.organizationId })
            .from(member)
            .where(eq(member.userId, session.userId))
            // No ORDER BY means Postgres may return any matching row — and a
            // different one across calls — for a user with multiple
            // memberships. Pin a deterministic order instead.
            .orderBy(asc(member.createdAt), asc(member.organizationId))
            .limit(1);

          let organizationId = rows[0]?.organizationId;

          // Self-heal: on a brand-new sign-up this is normally what actually
          // creates the organization (see the comment above); it also covers
          // user.create.after having failed outright on an earlier attempt.
          if (!organizationId) {
            const [u] = await db
              .select({ name: userTable.name, email: userTable.email })
              .from(userTable)
              .where(eq(userTable.id, session.userId))
              .limit(1);
            try {
              organizationId = await bootstrapOrganization(
                session.userId,
                `${u?.name || u?.email?.split('@')[0] || 'My'}'s library`,
              );
            } catch (err) {
              // Lost the race to user.create.after (or another concurrent
              // sign-in) — look the row up again instead of failing this
              // session creation.
              if (!(isAPIError(err) && err.body?.code === 'ORGANIZATION_ALREADY_EXISTS')) throw err;
              const retry = await db
                .select({ organizationId: member.organizationId })
                .from(member)
                .where(eq(member.userId, session.userId))
                .orderBy(asc(member.createdAt), asc(member.organizationId))
                .limit(1);
              organizationId = retry[0]?.organizationId;
            }
          }

          return {
            data: {
              ...session,
              ...(organizationId ? { activeOrganizationId: organizationId } : {}),
            },
          };
        },
      },
    },
  },
  plugins: [organization(), nextCookies()], // nextCookies LAST
});
