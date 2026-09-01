import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { reorderCollections } from '@/lib/collections';

export const maxDuration = 60;

const orderBody = z.object({ ids: z.array(z.string().min(1)).max(5000) });

// STATIC segment, deliberately placed beside the dynamic [id]/route.ts. Next
// resolves static segments before dynamic ones, so PATCH /api/collections/order
// reaches this file rather than being treated by [id]/route.ts as a rename of
// a collection whose id is the literal string "order".
export async function PATCH(request: Request) {
  const { orgId } = await requireOrg();

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = orderBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const result = await reorderCollections(orgId, parsed.data.ids);
  if (!result.ok) {
    const error = result.reason === 'unknown-id' ? 'unknown_id'
      : result.reason === 'duplicate-id' ? 'duplicate_id'
      : 'missing_id';
    return Response.json({ error, id: result.id }, { status: 400 });
  }

  return Response.json({ ok: true });
}
