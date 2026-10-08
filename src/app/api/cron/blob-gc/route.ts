import { runBlobGc } from '@/lib/blob-gc-run';

export const maxDuration = 300;

/**
 * Weekly blob garbage collection (vercel.ts). Guarded exactly like
 * /api/cron/scan: a cron call carries no session, so the shared CRON_SECRET is
 * the guard, and an unset secret fails CLOSED.
 *
 * It only DELETES when BLOB_GC_DELETE=1 is set in the environment; otherwise
 * every run is a dry run that reports what would go. Deleting is irreversible,
 * so it is switched on by the operator after seeing a dry run's numbers
 * (HANDOFF 3az). `?dryRun=1` forces a dry run either way.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const dryRun = process.env.BLOB_GC_DELETE !== '1'
    || new URL(request.url).searchParams.get('dryRun') === '1';
  const result = await runBlobGc({ dryRun });
  console.log('blob-gc:', JSON.stringify(result));
  return Response.json(result);
}
