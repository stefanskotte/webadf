// The recipient's remote libraries (spec §4.2, §4.5): GET lists this team's, POST {link} adds one from a share link.
import { z } from 'zod';
import { requireOrg } from '@/lib/session';
import { addRemoteLibrary, listRemoteLibraries } from '@/lib/remote/store';
import { hostOf } from '@/lib/remote/http';
import { parseShareLink } from '@/lib/share/link';

export const dynamic = 'force-dynamic';
// A claim may wait on the owner (10 s) and on fetching its pinned root.
export const maxDuration = 60;

export async function GET() {
  const { orgId } = await requireOrg();
  const rows = await listRemoteLibraries(orgId);
  return Response.json({ libraries: rows.map((r) => ({ ...r, host: hostOf(r.baseUrl) })) });
}

const addBody = z.object({ link: z.string().min(1).max(4096) });

/**
 * 201 {id}; 400 bad_link; 404 invalid_or_used ("already used, expired or revoked"); 409 protocol {host, detail?};
 * 502 unreachable / bad_response {host}. The same owner twice is two entries, not a refusal (final review 1).
 */
export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  let json: unknown;
  try { json = await request.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  const p = addBody.safeParse(json);
  if (!p.success) return Response.json({ error: 'invalid_body' }, { status: 400 });

  const r = await addRemoteLibrary(orgId, userId, p.data.link);
  const host = () => { const origin = parseShareLink(p.data.link)?.origin; return origin ? hostOf(origin) : null; };
  if (r.ok) return Response.json({ id: r.id }, { status: 201 });
  switch (r.reason) {
    case 'bad_link':
      return Response.json({ error: 'bad_link' }, { status: 400 });
    case 'invalid_or_used':
      return Response.json({ error: 'invalid_or_used' }, { status: 404 });
    case 'unreachable':
      return Response.json({ error: 'unreachable', host: host() }, { status: 502 });
    case 'bad_response':
      return Response.json({ error: 'bad_response', host: host() }, { status: 502 });
    default:
      return Response.json(r.detail ? { error: 'protocol', host: host(), detail: r.detail } : { error: 'protocol', host: host() }, { status: 409 });
  }
}
