import { getDb } from '@/db';
import { expireTransfers } from '@/lib/transfers';
import { expireUploads } from '@/lib/amiga-uploads';

/**
 * Daily (vercel.ts; the self-host scheduler runs the same list): files waiting for an Amiga longer than 24 h are
 * marked expired, and rows finished more than 7 days ago are deleted (PaulaNET Phase 4, spec 2026-10-16 §4). Uploads
 * from the Amiga (spec 2026-10-18 §4): a partial upload older than 24 h fails and drops its chunks; a stored file
 * past its 30 days goes. Guarded like every cron: the shared CRON_SECRET, failing CLOSED when unset.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const db = getDb();
  const result = await expireTransfers(db);
  const up = await expireUploads(db);
  console.log(`transfers: expired ${result.expired}, deleted ${result.deleted}; uploads: failed ${up.failed}, deleted ${up.deleted}`);
  return Response.json({ ...result, uploadsFailed: up.failed, uploadsDeleted: up.deleted });
}
