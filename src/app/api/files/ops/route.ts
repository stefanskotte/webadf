// POST /api/files/ops -- one Files operation (spec 2026-10-29 §4). The engine owns every status it assigns.
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { runOp, type OpRequest } from '@/lib/files/ops';

// Reads (and an op writes) disk images from the store: the same 60 s every byte-touching handler sets.
export const maxDuration = 60;

const path = z.string().min(1).max(1024);
const sources = z.array(path).min(1).max(1000);
const name = z.string().min(1).max(80);   // AmigaDOS rules on disks and in STASH:, collection rules on LIBRARY: (the engine applies them)
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.enum(['copy', 'move']), sources, dest: path, onClash: z.enum(['ask', 'replace', 'skip', 'keep-both']) }),
  z.object({ op: z.literal('delete'), sources }),
  z.object({ op: z.literal('makedir'), dest: path, name }),
  z.object({ op: z.literal('rename'), source: path, name }),
  z.object({ op: z.literal('protect'), sources, protection: z.number().int().min(0).max(255) }),
  z.object({ op: z.literal('comment'), source: path, comment: z.string().max(200) }),
  z.object({ op: z.literal('add-to-library'), sources }),
  z.object({ op: z.literal('create-adf'), dest: path, name, filesystem: z.enum(['OFS', 'FFS']), density: z.enum(['dd', 'hd']),
    onClash: z.enum(['ask', 'replace', 'skip', 'keep-both']) }),
]);

export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'invalid_body' }, { status: 400 });
  const r = await runOp({ orgId, userId }, body.data as OpRequest);
  if (r.kind === 'done') {
    return Response.json({ items: r.items, versions: r.versions, ...(r.added ? { added: r.added } : {}), ...(r.queued !== undefined ? { queued: r.queued } : {}) });
  }
  if (r.kind === 'clashes') return Response.json({ error: 'clashes', clashes: r.clashes }, { status: 409 });
  return Response.json({ error: r.refusal.code, detail: r.refusal.detail }, { status: r.status });
}
