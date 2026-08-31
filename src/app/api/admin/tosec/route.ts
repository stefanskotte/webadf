import { requireSuperAdmin } from '@/lib/superadmin';
import { importDat } from '@/lib/tosec-import';

// A large DAT is a few MB of text and parsing is CPU-bound; give it room.
export const maxDuration = 300;

/**
 * Import a TOSEC DAT. requireSuperAdmin() is called HERE, not merely in the
 * (admin) layout: a page render and a later fetch are separate requests.
 *
 * The body is the DAT's raw text. Both ClrMamePro and XML forms are accepted;
 * parseDat detects which.
 */
export async function POST(request: Request) {
  await requireSuperAdmin();
  const text = await request.text();
  if (text.trim().length === 0) {
    return Response.json({ error: 'empty' }, { status: 400 });
  }
  const result = await importDat(text);
  if (result.imported === 0) {
    // Parsed fine but produced nothing -- almost certainly not a DAT. Say so
    // rather than reporting a cheerful zero.
    return Response.json({ error: 'no_entries', ...result }, { status: 400 });
  }
  return Response.json(result);
}
