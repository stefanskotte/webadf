import { requireSuperAdmin } from '@/lib/superadmin';
import { importOpenRetro } from '@/lib/openretro-import';

// A real Amiga.sqlite is ~29 MB and parsing 21k zlib blobs is CPU-bound.
export const maxDuration = 300;

/**
 * Import an uploaded Amiga.sqlite.
 *
 * Reads the body as BINARY -- unlike /api/admin/tosec, which takes text.
 * requireSuperAdmin() is called here and not merely in the (admin) layout: a
 * page render and a later fetch are separate requests.
 */
export async function POST(request: Request) {
  await requireSuperAdmin();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return Response.json({ error: 'empty' }, { status: 400 });
  // "SQLite format 3\0" -- reject anything that is not a database before
  // handing 29 MB of who-knows-what to the parser.
  const magic = Buffer.from(bytes.subarray(0, 15)).toString('latin1');
  if (magic !== 'SQLite format 3') return Response.json({ error: 'not_sqlite' }, { status: 400 });

  const result = await importOpenRetro(bytes);
  if (result.games === 0) return Response.json({ error: 'no_games', ...result }, { status: 400 });
  return Response.json(result);
}
