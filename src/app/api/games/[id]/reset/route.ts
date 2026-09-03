import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { games, disks, blobs } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { openretroEntries } from '@/db/schema/openretro';
import { requireOrg } from '@/lib/session';
import { GROUPS, type Group } from '@/lib/game-edit';

export const maxDuration = 60;

const body = z.object({ group: z.enum(GROUPS) });

/**
 * Hand one group back to the scanners.
 *
 * Two things happen, and the second is what makes the control honest: the
 * authority column goes back to a machine value, AND the scanned values are
 * restored from this game's own matched entry. Clearing authority alone would
 * mean "your text stays until some future sweep happens to run", which is not
 * what a control called "use scanned data" says.
 *
 * applyMatch/applyEnrichment are deliberately NOT reused. They apply across
 * every tenant holding those bytes, and applyMatch can MERGE duplicate games --
 * far more than a person asked for by undoing one edit on one title. This
 * reads the same entries and writes this one row.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body', detail: z.flattenError(parsed.error) }, { status: 400 });
  }
  const group: Group = parsed.data.group;

  const db = getDb();
  const owned = await db.select({ id: games.id })
    .from(games).where(and(eq(games.id, id), eq(games.orgId, orgId))).limit(1);
  if (owned.length === 0) return Response.json({ error: 'not_found' }, { status: 404 });

  // This game's disks, and whichever entries a scan landed them on. The disks
  // predicate carries orgId as well as gameId: disks.orgId is an independent
  // column that can drift, and a join on gameId alone would let another
  // tenant's disk choose the entry this row is restored from.
  const rows = await db.select({
    tosecEntryId: blobs.tosecEntryId, openretroEntryId: blobs.openretroEntryId,
  })
    .from(disks)
    .innerJoin(blobs, eq(blobs.sha256, disks.sha256))
    .where(and(eq(disks.gameId, id), eq(disks.orgId, orgId)));

  const tosecIds = [...new Set(rows.map((r) => r.tosecEntryId).filter((v): v is string => v !== null))];
  const orIds = [...new Set(rows.map((r) => r.openretroEntryId).filter((v): v is string => v !== null))];

  const values: Record<string, string | number | null> = {};
  let restored = false;

  if (group === 'identity') {
    // 'filename', not NULL. NULL in metadataSource means HUMAN -- resetting to
    // it would leave the row frozen, the exact opposite of this control.
    // 'filename' is the honest "no scan has claimed this" value, and it is
    // what ingest writes.
    values.metadataSource = 'filename';
    if (tosecIds.length > 0) {
      const e = (await db.select().from(tosecEntries)
        .where(inArray(tosecEntries.id, tosecIds)).limit(1))[0];
      if (e) {
        values.title = e.title;
        values.sortTitle = e.sortTitle;
        values.year = e.year;
        values.publisher = e.publisher;
        values.metadataSource = 'tosec';
        restored = true;
      }
    }
  } else if (orIds.length > 0) {
    const e = (await db.select().from(openretroEntries)
      .where(inArray(openretroEntries.uuid, orIds)).limit(1))[0];
    if (e) {
      if (group === 'facts') {
        values.developer = e.developer;
        values.players = e.players;
        values.genre = e.tags;
        values.chipset = e.chipset;
        values.factsSource = 'openretro';
        restored = true;
      } else {
        const prose = e.longDescription ?? e.description;
        if (prose !== null) {
          values.description = prose;
          values.proseSource = 'openretro';
          restored = true;
        }
      }
    }
  }

  if (!restored && group !== 'identity') {
    // NULL is right for these two: it is their never-written state, which
    // means machine-writable. That is the opposite of NULL in metadataSource,
    // and the asymmetry is deliberate -- see openretro-apply's machineOwned().
    values[group === 'facts' ? 'factsSource' : 'proseSource'] = null;
  }

  await db.update(games).set(values).where(and(eq(games.id, id), eq(games.orgId, orgId)));
  // `restored` says whether values actually came back or only the authority
  // was released -- a reset with nothing ever scanned cannot invent data, and
  // the UI must not claim it did.
  return Response.json({ id, group, restored });
}
