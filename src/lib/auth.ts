import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization as organizationPlugin } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { isAPIError } from 'better-auth/api';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { member, user as userTable, organization as organizationTable } from '@/db/schema/auth';

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

function isOrgAlreadyExists(err: unknown) {
  return isAPIError(err) && err.body?.code === 'ORGANIZATION_ALREADY_EXISTS';
}

function isAlreadyAMember(err: unknown) {
  return isAPIError(err) && err.body?.code === 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION';
}

async function lookupActiveOrgId(db: ReturnType<typeof getDb>, userId: string) {
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    // No ORDER BY means Postgres may return any matching row — and a
    // different one across calls — for a user with multiple memberships.
    // Pin a deterministic order instead.
    .orderBy(asc(member.createdAt), asc(member.organizationId))
    .limit(1);
  return rows[0]?.organizationId;
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
          // Not atomic with user creation. And, per the ordering discovery
          // above, this hook does NOT run until the entire sign-up handler
          // has already finished: `linkAccount` (the password credential)
          // and `createSession` (session cookie included) both complete
          // first. So on the sign-up path, a rethrow here would not strand a
          // credential-less user — the user is already fully signed up and
          // signed in by the time this runs. It would instead surface a
          // false "Sign up failed" to a client that actually succeeded.
          // Still swallow and log rather than throw: this hook is also the
          // only bootstrap path for user-creation flows that don't create a
          // session in the same request (e.g. an admin creating a user
          // directly), where a thrown error here really would abort that
          // request. session.create.before repairs a missing org lazily on
          // whatever sign-in eventually follows.
          try {
            await bootstrapOrganization(user.id, `${user.name || user.email.split('@')[0]}'s library`);
          } catch (err) {
            if (isOrgAlreadyExists(err)) return;
            console.error(`[auth] failed to bootstrap organization for user ${user.id}`, err);
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
          let organizationId = await lookupActiveOrgId(db, session.userId);

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
              if (!isOrgAlreadyExists(err)) throw err;

              // Lost the race to user.create.after (or another concurrent
              // sign-in) — the organization exists, look the membership up
              // again instead of failing this session creation.
              organizationId = await lookupActiveOrgId(db, session.userId);

              // Wedge case: createOrganization writes the organization row
              // and the member row as two separate, non-atomic calls (no
              // enclosing SQL transaction — `transaction: false` above), so
              // it's possible for the org to exist with no matching member
              // row (a failed/interrupted member insert on whichever call
              // won the race). Left alone, that's permanent: the slug is
              // taken, so every future sign-in would hit
              // ORGANIZATION_ALREADY_EXISTS again and land back here with
              // still no membership — requireOrg() would send the user to
              // /onboarding forever. Repair it by looking the organization
              // up by its deterministic slug and adding the membership.
              if (!organizationId) {
                const [org] = await db
                  .select({ id: organizationTable.id })
                  .from(organizationTable)
                  .where(eq(organizationTable.slug, `org-${session.userId}`))
                  .limit(1);
                if (org) {
                  try {
                    const newMember = await auth.api.addMember({
                      body: { userId: session.userId, organizationId: org.id, role: 'owner' },
                    });
                    organizationId = newMember.organizationId;
                  } catch (repairErr) {
                    if (isAlreadyAMember(repairErr)) {
                      // Repaired by a concurrent sign-in between our lookup
                      // and our own addMember call.
                      organizationId = org.id;
                    } else {
                      // Give up gracefully — requireOrg() sends the user to
                      // onboarding rather than failing sign-in outright, and
                      // the next sign-in tries the repair again.
                      console.error(`[auth] failed to repair missing membership for user ${session.userId} in organization ${org.id}`, repairErr);
                    }
                  }
                }
              }
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
  plugins: [organizationPlugin(), nextCookies()], // nextCookies LAST
});
