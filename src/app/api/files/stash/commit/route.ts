// POST /api/files/stash/commit -- a browser drop into a STASH: folder, after its files' presigned PUTs (Files spec
// 2026-10-29 §4.2, R6): the server verifies each file's size and sha-256 and stores the rows (stash-commit.ts).
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { parsePath } from '@/lib/files/path';
import { commitToStash } from '@/lib/files/stash-commit';
import { STASH_FILE_MAX } from '@/lib/files/stash-paths';

// Every file's bytes are read back and hashed (up to 64 MB): the same 60 s every Files handler sets.
export const maxDuration = 60;

const Body = z.object({
  dir: z.string().min(1).max(1024),
  onClash: z.enum(['ask', 'replace', 'skip', 'keep-both']),
  // Over 200 entries is the commit's own 413 (stash-commit.ts); this only bounds what is parsed.
  entries: z.array(z.object({
    path: z.string().min(1).max(1024),
    kind: z.enum(['file', 'dir']),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    sizeBytes: z.number().int().min(0).max(STASH_FILE_MAX),
    lastModified: z.number().int().min(0).max(8.64e15).optional(),   // the largest time a Date holds
  })).min(1).max(1000),
});

export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const dir = parsePath(body.data.dir);
  if (!dir || dir.device !== 'STASH') return Response.json({ error: 'bad_path' }, { status: 400 });
  const r = await commitToStash({ orgId, userId, versions: [] }, dir, body.data.entries, body.data.onClash);
  if (r.kind === 'clashes') return Response.json({ error: 'clashes', clashes: r.clashes }, { status: 409 });
  if (r.kind === 'refused') return Response.json({ error: r.refusal.code, detail: r.refusal.detail }, { status: r.status });
  return Response.json({ items: r.items, renamed: r.renamed ?? [] });
}
