import { getDb } from '@/db';
import { expireTransfers } from '@/lib/transfers';

/**
 * Daily (vercel.ts; the self-host scheduler runs the same list): files waiting for an Amiga longer than 24 h are
 * marked expired, and rows finished more than 7 days ago are deleted (PaulaNET Phase 4, spec 2026-10-16 §4). Guarded
 * like every cron: the shared CRON_SECRET, failing CLOSED when unset.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const result = await expireTransfers(getDb());
  console.log(`transfers: expired ${result.expired}, deleted ${result.deleted}`);
  return Response.json(result);
}
