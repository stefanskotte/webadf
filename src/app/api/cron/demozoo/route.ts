import { runDemozooCron } from '@/lib/demozoo/import';

export const maxDuration = 300;

/**
 * Daily. It FETCHES from Demozoo at most once a week (import.ts nextStep) and
 * spends the other days resuming an unfinished import from our own copy.
 * Same guard as /api/cron/scan: CRON_SECRET, failing closed when unset.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  return Response.json(await runDemozooCron());
}
