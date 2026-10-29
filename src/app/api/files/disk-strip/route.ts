// GET /api/files/disk-strip?diskId= -- a pane's disk strip after the pane moved into a disk on the client, and again
// after anything changed the disk (Files increment 1, Task 9). The page reads the same thing for its first render.
import { requireOrg } from '@/lib/session';
import { diskStripData } from '@/lib/files/disk-strip-data';

// The History reads up to a few dozen versions' bytes: the same 60 s every byte-touching handler sets.
export const maxDuration = 60;

export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const diskId = new URL(request.url).searchParams.get('diskId') ?? '';
  if (!diskId) return Response.json({ error: 'bad_request' }, { status: 400 });
  const data = await diskStripData(orgId, diskId);
  if (!data) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(data);
}
