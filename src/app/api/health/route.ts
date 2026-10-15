import { sql } from 'drizzle-orm';
import { getDb } from '@/db';

export const dynamic = 'force-dynamic';

/** Container healthcheck (self-hosting P2): 200 when the database answers. No details. */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return new Response('ok');
  } catch {
    return new Response('db unavailable', { status: 503 });
  }
}
