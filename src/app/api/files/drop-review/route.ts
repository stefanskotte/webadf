// GET /api/files/drop-review?path= -- the disk a pane shows, as the drop review needs it, when files from the computer
// are dropped on that pane (Files increment 1, Task 9b).
import { requireOrg } from '@/lib/session';
import { parsePath } from '@/lib/files/path';
import { BlobUnavailableError } from '@/lib/files/library';
import { dropReviewData } from '@/lib/files/drop-review-data';

// Reads the disk image from the store: the same 60 s every byte-touching handler sets.
export const maxDuration = 60;

export async function GET(request: Request) {
  const { orgId, userId } = await requireOrg();
  const p = parsePath(new URL(request.url).searchParams.get('path') ?? '');
  if (!p) return Response.json({ error: 'bad_path' }, { status: 400 });
  let data: Awaited<ReturnType<typeof dropReviewData>>;
  try { data = await dropReviewData({ orgId, userId }, p); } catch (e) {
    if (e instanceof BlobUnavailableError) return Response.json({ error: 'blob_unavailable' }, { status: 503 });
    throw e;
  }
  if (!data) return Response.json({ error: 'not_found' }, { status: 404 });
  if ('refused' in data) return Response.json({ error: data.refused, detail: data.detail }, { status: 409 });
  return Response.json(data);
}
