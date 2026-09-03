import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { games } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { GROUP_COLUMN, planEdit, EditError, type GameEditCurrent } from '@/lib/game-edit';
import { deleteGame } from '@/lib/disk-delete';

export const maxDuration = 60;

/**
 * Every editable field, all optional. The source columns are deliberately NOT
 * in this schema and never will be: authority is something this route DERIVES
 * from what actually changed, never something a request body may assert.
 */
const patchBody = z.object({
  title: z.string().optional(),
  year: z.union([z.number(), z.string(), z.null()]).optional(),
  publisher: z.string().nullable().optional(),
  developer: z.string().nullable().optional(),
  players: z.string().nullable().optional(),
  genre: z.string().nullable().optional(),
  chipset: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  history: z.string().nullable().optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }

  const db = getDb();
  // Read first, because an edit is a DIFF: only genuinely changed fields may
  // stamp a group. Org-scoped here as well as on the update -- a title from
  // another tenant must 404 rather than reveal that it exists.
  const rows = await db.select({
    title: games.title, year: games.year, publisher: games.publisher,
    developer: games.developer, players: games.players,
    genre: games.genre, chipset: games.chipset,
    description: games.description, history: games.history,
  }).from(games).where(and(eq(games.id, id), eq(games.orgId, orgId))).limit(1);

  const current = rows[0] as GameEditCurrent | undefined;
  if (!current) return Response.json({ error: 'not_found' }, { status: 404 });

  let plan;
  try {
    plan = planEdit(parsed.data, current);
  } catch (e) {
    if (e instanceof EditError) return Response.json({ error: 'invalid_field', detail: e.message }, { status: 400 });
    throw e;
  }

  // Nothing changed: say so without writing. Stamping here would freeze every
  // group on the row merely because someone opened the editor and saved.
  if (plan.touched.length === 0) return Response.json({ id, changed: [] });

  // 'human' is any value outside MACHINE_SOURCES; the literal string is what
  // the rest of the system reads back, so it is written once, here.
  const stamps = Object.fromEntries(plan.touched.map((g) => [GROUP_COLUMN[g], 'human']));

  const updated = await db.update(games)
    .set({ ...plan.values, ...stamps })
    .where(and(eq(games.id, id), eq(games.orgId, orgId)))
    .returning({ id: games.id });

  if (updated.length === 0) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ id, changed: plan.touched });
}

/**
 * Remove a title and every disk on it.
 *
 * The BLOB is never removed: it is global and content-addressed, and other
 * tenants may hold the same bytes. What goes is this org's entitlement, and
 * only for bytes no other disk of theirs still references.
 */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  const result = await deleteGame(orgId, id);
  // 404, never 403: the response must not confirm another tenant's id exists.
  if (!result) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(result);
}
