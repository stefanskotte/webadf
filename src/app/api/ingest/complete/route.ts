import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@/db';
import { blobs, entitlements, games, disks } from '@/db/schema/catalog';
import { requireOrg } from '@/lib/session';
import { diskStore } from '@/lib/storage';
import { completeBody } from '@/lib/ingest';
import { groupDisks } from '@/lib/grouping';
import { parseTosecName } from '@/lib/tosec';

export async function POST(request: Request) {
  const { orgId } = await requireOrg();

  const parsed = completeBody.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }

  const db = getDb();
  const files = parsed.data.files;

  // Never trust the client that the bytes landed.
  const present = await Promise.all(files.map((f) => diskStore.exists(f.sha256)));
  const landed = files.filter((_, i) => present[i]);
  const rejected = files.filter((_, i) => !present[i]).map((f) => f.sha256);

  if (landed.length === 0) {
    return Response.json({ created: 0, rejected }, { status: 409 });
  }

  await db.insert(blobs).values(landed.map((f) => ({
    sha256: f.sha256, sizeBytes: f.sizeBytes, storageKey: diskStore.storageKey(f.sha256),
  }))).onConflictDoNothing();

  await db.insert(entitlements).values(landed.map((f) => ({
    orgId, sha256: f.sha256, sourceFilename: f.filename,
  }))).onConflictDoNothing();

  // parseTosecName returns title: '' for a filename that is empty or is
  // nothing but an extension/bracket clause (e.g. ".adf", "[cr].adf"). The
  // bytes still landed and the entitlement above is still valid — a bad
  // filename doesn't mean the upload failed — but we must not write a
  // games row with an empty title, and grouping these under one blank-title
  // "game" key would incorrectly merge unrelated uploads. So: filter them
  // out of the grouping input entirely and report them separately.
  const groupable = landed.filter((f) => parseTosecName(f.filename).title.trim() !== '');
  const skippedTitle = landed
    .filter((f) => parseTosecName(f.filename).title.trim() === '')
    .map((f) => f.sha256);

  const grouped = groupDisks(groupable.map((f) => ({
    filename: f.filename, sha256: f.sha256, sizeBytes: f.sizeBytes,
  })));

  for (const g of grouped) {
    const gameId = randomUUID();
    await db.insert(games).values({
      id: gameId, orgId, title: g.title, sortTitle: g.sortTitle,
      year: g.year, publisher: g.publisher, metadataSource: 'filename',
    });
    await db.insert(disks).values(g.disks.map((d) => ({
      id: randomUUID(), gameId, orgId, diskNo: d.diskNo, sha256: d.sha256,
      tosecName: d.filename, isBoot: d.isBoot, sizeBytes: d.sizeBytes,
    })));
  }

  return Response.json({
    created: grouped.length,
    disks: groupable.length,
    rejected,
    skippedTitle,
  });
}
