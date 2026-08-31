import { sweep } from '@/lib/tosec-sweep';

export const maxDuration = 300;

/**
 * Scheduled sweep. NOT behind requireSuperAdmin(): a cron invocation carries
 * no session. The platform's documented mechanism is a shared secret in the
 * Authorization header, so that is the guard.
 *
 * Fails CLOSED when CRON_SECRET is unset -- an unset secret must never mean
 * "allow anyone", which is the same rule SUPERADMIN_EMAILS follows.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  return Response.json(await sweep());
}
