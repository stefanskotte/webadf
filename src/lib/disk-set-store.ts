/**
 * Disk sets (spec 2026-09-28-disk-sets §2, §4): applies the pure plans from
 * disk-set.ts to the library, each operation as ONE db.batch (neon-http has no
 * interactive transactions; tosec-apply.ts's mergeDuplicates is the model).
 *
 * THE DANGER HERE IS THE CASCADE. disks.game_id references games.id with
 * ON DELETE CASCADE, so deleting a title that still holds a disk destroys that
 * disk -- and a destroyed disk is indistinguishable from an eject on a board
 * that wants it. Every title delete below is therefore defended twice:
 *
 *  1. The plan only calls a title emptied after the store has loaded EVERY
 *     disk of it (planAddDisks trusts allDisksOfSources to be complete), and
 *     the batch moves those disks out BEFORE the delete runs.
 *  2. The DELETE itself carries `NOT EXISTS (select 1 from disks d where
 *     d.game_id = games.id)`, deliberately NOT org-scoped: disks.org_id can
 *     drift from its game's org (admin-delete.ts), so a disk the org-scoped
 *     read missed still keeps its title alive. The collection_games delete
 *     carries the same guard, so a title that survives keeps its memberships.
 *
 * Batch order (controller ruling 2): disks, devices, the target title, then
 * collection_games, then games.
 *
 * Devices: only desired_game_id/desired_disk_no and mounted_game_id/
 * mounted_disk_no are written, per device id, org-scoped, and only while the
 * device still names the disk the plan was made from. desired_disk_id,
 * mounted_disk_id and desired_version are never touched: disks keep their ids,
 * so no board's wanted disk changes and nothing is ejected.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getDb } from '@/db';
import { games, disks, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import { collections, collectionGames } from '@/db/schema/collections';
import {
  planAddDisks, planReorder, planMoveOut, type DeviceRef, type Plan, type SetDisk,
  PlanError,
} from '@/lib/disk-set';
import { stableId } from '@/lib/ingest';
import { makeSortTitle } from '@/lib/tosec';

/**
 * What Undo needs to recreate an emptied title. No sortTitle: the server
 * derives it from `title` (makeSortTitle) rather than trusting the client's.
 * diskOrderSource is carried so a human-arranged title comes back human-arranged
 * (TOSEC re-application and the upload suggestion both respect that flag).
 */
export type UndoSnapshot = {
  diskIds: string[]; title: string; year: number | null; publisher: string | null;
  metadataSource: string | null; diskOrderSource: 'human' | null; hadExtras: boolean;
};

/** A title or disk that is unknown or belongs to another org -- indistinguishable on purpose. */
export class NotFound extends Error {
  constructor() { super('not_found'); }
}

type Db = ReturnType<typeof getDb>;
type Stmt = BatchItem<'pg'>;

const setDisk = { id: disks.id, gameId: disks.gameId, diskNo: disks.diskNo };

export async function orgDevices(db: Db, orgId: string): Promise<DeviceRef[]> {
  return db.select({ id: devices.id, desiredDiskId: devices.desiredDiskId, mountedDiskId: devices.mountedDiskId })
    .from(devices).where(eq(devices.orgId, orgId));
}

/** The title, org-scoped, else NotFound. Answers its current name. */
async function requireGame(db: Db, orgId: string, gameId: string): Promise<{ title: string }> {
  const rows = await db.select({ id: games.id, title: games.title }).from(games)
    .where(and(eq(games.id, gameId), eq(games.orgId, orgId))).limit(1);
  if (rows.length === 0) throw new NotFound();
  return { title: rows[0].title };
}

async function disksOf(db: Db, orgId: string, gameId: string): Promise<SetDisk[]> {
  return db.select(setDisk).from(disks).where(and(eq(disks.gameId, gameId), eq(disks.orgId, orgId)));
}

/** The title has no disk left at all, in ANY org (see the header). */
const noDiskLeft = (gameIdCol: typeof games.id | typeof collectionGames.gameId) =>
  sql`not exists (select 1 from ${disks} "d" where "d"."game_id" = ${gameIdCol})`;

/** The disk is in this title at this number (checked inside the batch, after the disk moves). */
const diskIsAt = (diskId: string, gameId: string, diskNo: number) =>
  sql`exists (select 1 from ${disks} "d" where "d"."id" = ${diskId} and "d"."game_id" = ${gameId} and "d"."disk_no" = ${diskNo})`;

/**
 * Statements 1 and 2 of every batch: the disk moves, then the devices. Each
 * disk UPDATE is pinned to the title the plan read it in (Renumber.fromGameId),
 * so a disk another tab moved meanwhile stays where that tab put it.
 * Also used by disk-delete.ts to close the gap a deleted disk leaves.
 */
export function applyPlan(db: Db, orgId: string, plan: Plan, devs: DeviceRef[]): Stmt[] {
  const out: Stmt[] = [];
  for (const r of plan.renumber) {
    out.push(db.update(disks).set({ gameId: r.gameId, diskNo: r.diskNo })
      .where(and(eq(disks.id, r.diskId), eq(disks.orgId, orgId), eq(disks.gameId, r.fromGameId))));
  }
  const byId = new Map(devs.map((d) => [d.id, d]));
  for (const u of plan.devices) {
    const ref = byId.get(u.deviceId);
    // Each device UPDATE also requires the disk to really sit where the plan
    // put it: a disk UPDATE pinned to fromGameId matches nothing when another
    // tab moved the disk meanwhile, and the board must then not be told this
    // plan's title and number. Sound because the batch runs in order, as one
    // transaction, so the disk UPDATEs above are already visible here.
    if (u.desired && ref?.desiredDiskId) {
      out.push(db.update(devices).set({ desiredGameId: u.desired.gameId, desiredDiskNo: u.desired.diskNo })
        .where(and(eq(devices.id, u.deviceId), eq(devices.orgId, orgId), eq(devices.desiredDiskId, ref.desiredDiskId),
          diskIsAt(ref.desiredDiskId, u.desired.gameId, u.desired.diskNo))));
    }
    if (u.mounted && ref?.mountedDiskId) {
      out.push(db.update(devices).set({ mountedGameId: u.mounted.gameId, mountedDiskNo: u.mounted.diskNo })
        .where(and(eq(devices.id, u.deviceId), eq(devices.orgId, orgId), eq(devices.mountedDiskId, ref.mountedDiskId),
          diskIsAt(ref.mountedDiskId, u.mounted.gameId, u.mounted.diskNo))));
    }
  }
  return out;
}

/** Statements 4 and 5: memberships, then the titles -- both guarded. */
function deleteEmptied(db: Db, orgId: string, emptied: string[]): Stmt[] {
  if (emptied.length === 0) return [];
  return [
    db.delete(collectionGames).where(and(
      inArray(collectionGames.gameId, emptied), noDiskLeft(collectionGames.gameId))),
    db.delete(games).where(and(
      inArray(games.id, emptied), eq(games.orgId, orgId), noDiskLeft(games.id))),
  ];
}

function markHuman(db: Db, orgId: string, gameId: string): Stmt {
  return db.update(games).set({ diskOrderSource: 'human' })
    .where(and(eq(games.id, gameId), eq(games.orgId, orgId)));
}

export async function run(db: Db, stmts: Stmt[]): Promise<void> {
  if (stmts.length === 0) return;
  await db.batch(stmts as [Stmt, ...Stmt[]]);
}

/**
 * What to add: disk ids (each brings its whole title), or whole titles
 * (a library card dropped on a card).
 */
export type AddPick = string[] | { sourceGameIds: string[] };

/**
 * Every disk of each source title, org-scoped, titles in the order given and
 * each title's disks in disk order. The result feeds the disk-id path below
 * unchanged, so there is one planner and one batch, and that path re-reads
 * every disk of each source itself before anything is deleted.
 */
async function diskIdsOfTitles(db: Db, orgId: string, gameId: string, sourceGameIds: string[]): Promise<string[]> {
  const ids = [...new Set(sourceGameIds)];
  if (ids.length === 0) throw new PlanError('nothing_to_add');
  if (ids.includes(gameId)) throw new PlanError('same_title');
  const found = await db.select({ id: games.id }).from(games)
    .where(and(inArray(games.id, ids), eq(games.orgId, orgId)));
  // A title of another org is indistinguishable from an unknown one.
  if (found.length !== ids.length) throw new NotFound();
  const all = await db.select(setDisk).from(disks)
    .where(and(inArray(disks.gameId, ids), eq(disks.orgId, orgId)));
  const out: string[] = [];
  for (const g of ids) {
    const mine = all.filter((d) => d.gameId === g)
      .sort((a, b) => a.diskNo - b.diskNo || (a.id < b.id ? -1 : 1));
    if (mine.length === 0) throw new PlanError('nothing_to_add');
    out.push(...mine.map((d) => d.id));
  }
  return out;
}

export async function addDisksToSet(
  orgId: string, gameId: string, pick: AddPick, rename?: string,
): Promise<{ undo: UndoSnapshot[] }> {
  const db = getDb();
  if ((Array.isArray(pick) ? pick : pick.sourceGameIds).length === 0) throw new PlanError('nothing_to_add');

  const current = await requireGame(db, orgId, gameId);
  const ids = Array.isArray(pick) ? [...new Set(pick)] : await diskIdsOfTitles(db, orgId, gameId, pick.sourceGameIds);
  const targetDisks = await disksOf(db, orgId, gameId);
  // Back in the order the caller sent: planAddDisks appends source titles in
  // the order it meets them, and an IN (...) read comes back in whatever
  // order the database likes -- which put a suggestion's disks in a random
  // order instead of the one the person arranged in the panel.
  const rank = new Map(ids.map((id, i) => [id, i]));
  const picked = (await db.select(setDisk).from(disks)
    .where(and(inArray(disks.id, ids), eq(disks.orgId, orgId))))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  if (picked.length !== ids.length) throw new NotFound();
  if (picked.some((d) => d.gameId === gameId)) throw new PlanError('same_title');

  const sourceIds = [...new Set(picked.map((d) => d.gameId))];
  const sources = await db.select({
    id: games.id, title: games.title, year: games.year, publisher: games.publisher,
    metadataSource: games.metadataSource, diskOrderSource: games.diskOrderSource, coverAssetId: games.coverAssetId, demozooProductionId: games.demozooProductionId,
    coverOverrideSha256: games.coverOverrideSha256,
  }).from(games).where(and(inArray(games.id, sourceIds), eq(games.orgId, orgId)));
  // A disk whose title is not this org's (org_id drift) is refused, never moved:
  // this operation must not delete or strip another org's title.
  if (sources.length !== sourceIds.length) throw new NotFound();

  // EVERY disk of each source title (controller ruling 1): the plan empties
  // and deletes each source, so a disk missing here would be left behind.
  const allOfSources = await db.select(setDisk).from(disks)
    .where(and(inArray(disks.gameId, sourceIds), eq(disks.orgId, orgId)));
  const inCollection = await db.select({ gameId: collectionGames.gameId }).from(collectionGames)
    .innerJoin(collections, and(eq(collections.id, collectionGames.collectionId), eq(collections.orgId, orgId)))
    .where(inArray(collectionGames.gameId, sourceIds));
  const devs = await orgDevices(db, orgId);

  // A rename is the suggestion path: the set is new, so number it from 1.
  const plan = planAddDisks({ gameId, disks: targetDisks }, picked, allOfSources, devs, { compact: rename !== undefined });

  const from = new Map(allOfSources.map((d) => [d.id, d.gameId]));
  const collected = new Set(inCollection.map((c) => c.gameId));
  const undo: UndoSnapshot[] = plan.emptiedGameIds.map((gid) => {
    const g = sources.find((s) => s.id === gid)!;
    return {
      diskIds: plan.renumber.filter((r) => from.get(r.diskId) === gid).map((r) => r.diskId),
      title: g.title, year: g.year, publisher: g.publisher, metadataSource: g.metadataSource,
      diskOrderSource: g.diskOrderSource === 'human' ? 'human' : null,
      // A person's own cover is an extra too: Undo recreates the title without it.
      hadExtras: g.coverAssetId !== null || g.coverOverrideSha256 !== null || g.demozooProductionId !== null
        || collected.has(gid),
    };
  });

  // A rename equal to the current name is not an edit: stamping 'human'
  // then would freeze a TOSEC/OpenRetro/Demozoo-identified title against
  // later corrections merely because the prefilled name was left alone.
  // It still numbers the set from 1 (compact, above) -- the set is new.
  const renamed = rename !== undefined && rename.trim() !== current.title ? rename.trim() : undefined;
  const target = db.update(games).set(renamed === undefined
    ? { diskOrderSource: 'human' }
    : { diskOrderSource: 'human', title: renamed, sortTitle: makeSortTitle(renamed), metadataSource: 'human' })
    .where(and(eq(games.id, gameId), eq(games.orgId, orgId)));

  await run(db, [...applyPlan(db, orgId, plan, devs), target, ...deleteEmptied(db, orgId, plan.emptiedGameIds)]);
  return { undo };
}

export async function reorderSet(orgId: string, gameId: string, orderedIds: string[]): Promise<void> {
  const db = getDb();
  await requireGame(db, orgId, gameId);
  const current = await disksOf(db, orgId, gameId);
  const devs = await orgDevices(db, orgId);
  const plan = planReorder({ gameId, disks: current }, orderedIds, devs);
  await run(db, [...applyPlan(db, orgId, plan, devs), markHuman(db, orgId, gameId)]);
}

// Only a disk image's own extension: "Game v1.2" (no extension) keeps its ".2".
const stripExt = (name: string) => name.replace(/\.(adf|adz|dms|hfe|ipf)$/i, '').trim();

/**
 * The uploaded file's name without its extension, else the TOSEC name without
 * its extension, else "Disk" (e.g. amiga-wb31_extras). Never reads the image:
 * until 2026-09-29 this was the Amiga volume name; the operator changed it to
 * the file name.
 */
async function nameFor(db: Db, orgId: string, disk: { sha256: string; tosecName: string | null }): Promise<string> {
  const ent = await db.select({ sourceFilename: entitlements.sourceFilename }).from(entitlements)
    .where(and(eq(entitlements.orgId, orgId), eq(entitlements.sha256, disk.sha256))).limit(1);
  const fromFile = ent[0] ? stripExt(ent[0].sourceFilename) : '';
  const fromTosec = disk.tosecName ? stripExt(disk.tosecName) : '';
  return fromFile || fromTosec || 'Disk';
}

export async function moveDiskOut(orgId: string, diskId: string): Promise<{ gameId: string }> {
  const db = getDb();
  const rows = await db.select({ ...setDisk, sha256: disks.sha256, tosecName: disks.tosecName }).from(disks)
    .where(and(eq(disks.id, diskId), eq(disks.orgId, orgId))).limit(1);
  const disk = rows[0];
  if (!disk) throw new NotFound();
  const remaining = await db.select(setDisk).from(disks)
    .where(and(eq(disks.gameId, disk.gameId), eq(disks.orgId, orgId), ne(disks.id, diskId)));
  // A lone disk is not in a set (controller ruling d): moving it out would
  // only swap its title for a bare one, losing the cover, Demozoo link,
  // collections, year and publisher. Refused before anything is written.
  if (remaining.length === 0) throw new PlanError('not_in_a_set');
  await requireGame(db, orgId, disk.gameId);

  const title = await nameFor(db, orgId, disk);
  const newId = stableId('game', orgId, 'moved-out', diskId, String(Date.now()));
  const devs = await orgDevices(db, orgId);
  const plan = planMoveOut({ id: disk.id, gameId: disk.gameId, diskNo: disk.diskNo }, newId, remaining, devs);

  await run(db, [
    db.insert(games).values({ id: newId, orgId, title, sortTitle: makeSortTitle(title), metadataSource: 'human' }),
    ...applyPlan(db, orgId, plan, devs),
    markHuman(db, orgId, disk.gameId),
    ...deleteEmptied(db, orgId, plan.emptiedGameIds),
  ]);
  return { gameId: newId };
}

export async function undoMove(orgId: string, snap: UndoSnapshot): Promise<{ gameId: string }> {
  const db = getDb();
  const ids = [...new Set(snap.diskIds)];
  if (ids.length === 0 || ids.length !== snap.diskIds.length) throw new NotFound();
  const moving = await db.select(setDisk).from(disks)
    .where(and(inArray(disks.id, ids), eq(disks.orgId, orgId)));
  if (moving.length !== ids.length) throw new NotFound();

  // A stale snapshot is refused, never half-applied (controller ruling): the
  // disks must still sit together in ONE title, and that title must keep at
  // least one disk of its own -- undo never deletes a title.
  const leftIds = [...new Set(moving.map((d) => d.gameId))];
  if (leftIds.length !== 1) throw new PlanError('stale_undo');
  const leftDisks = await db.select(setDisk).from(disks)
    .where(and(inArray(disks.gameId, leftIds), eq(disks.orgId, orgId)));
  const left = await db.select({ id: games.id }).from(games)
    .where(and(inArray(games.id, leftIds), eq(games.orgId, orgId)));
  if (left.length !== leftIds.length) throw new NotFound();
  const devs = await orgDevices(db, orgId);

  const newId = stableId('game', orgId, 'undo', ids.join(','), String(Date.now()));
  // The disks, 1..N in snapshot order, and the set they leave, 1..N in its
  // current order -- each a reorder of a known list, so planReorder builds
  // both the renumbers and the device updates.
  // `moving` keeps each disk's current gameId: that is what its UPDATE is pinned to.
  const plans: Plan[] = [planReorder({ gameId: newId, disks: moving }, ids, devs)];
  const gid = leftIds[0];
  const rest = leftDisks.filter((d) => d.gameId === gid && !ids.includes(d.id))
    .sort((a, b) => a.diskNo - b.diskNo || (a.id < b.id ? -1 : 1));
  if (rest.length === 0) throw new PlanError('stale_undo');
  plans.push(planReorder({ gameId: gid, disks: rest }, rest.map((d) => d.id), devs));
  const merged: Plan = {
    renumber: plans.flatMap((p) => p.renumber), emptiedGameIds: [], devices: plans.flatMap((p) => p.devices),
  };

  await run(db, [
    db.insert(games).values({
      id: newId, orgId, title: snap.title, sortTitle: makeSortTitle(snap.title), year: snap.year, publisher: snap.publisher,
      metadataSource: snap.metadataSource, diskOrderSource: snap.diskOrderSource,
    }),
    ...applyPlan(db, orgId, merged, devs),
  ]);
  return { gameId: newId };
}
