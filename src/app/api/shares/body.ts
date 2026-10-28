// Request bodies for the owner's /api/shares routes (session auth). Bounds are generous; the store has the real rules.
import { z } from 'zod';

const collectionIds = z.array(z.string().min(1).max(100)).max(500);

export const createShareBody = z.object({
  label: z.string().max(200),
  everything: z.boolean(),
  collectionIds: collectionIds.default([]),
});

export const scopeBody = z.object({
  everything: z.boolean(),
  collectionIds: collectionIds.default([]),
});

/** The parsed JSON body, or the 400 to answer with. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let body: unknown;
  try { body = await request.json(); } catch {
    return { ok: false, res: Response.json({ error: 'invalid_json' }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, res: Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}
