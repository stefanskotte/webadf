// Clear staging rows by key (spec 2026-10-23): only the org's own rows go; the count says how many did.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { clearStaging } from '@/lib/staging-server';

export const maxDuration = 60;

const body = z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(1000) });

export async function POST(request: Request) {
  const { orgId } = await requireOrg();
  const p = body.safeParse(await request.json().catch(() => null));
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const cleared = await clearStaging(getDb(), orgId, p.data.keys);
  return Response.json({ cleared }, { headers: { 'cache-control': 'no-store' } });
}
