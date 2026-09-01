import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { listCollections, createCollection } from '@/lib/collections';

export const maxDuration = 60;

const createBody = z.object({ name: z.string().trim().min(1).max(80) });

export async function GET() {
  const { orgId } = await requireOrg();
  const collections = await listCollections(orgId);
  return Response.json(collections);
}

export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = createBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const created = await createCollection(orgId, parsed.data.name);
  return Response.json(created, { status: 200 });
}
