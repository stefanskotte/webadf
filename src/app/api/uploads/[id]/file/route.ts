// Download a file from the Amiga (spec 2026-10-18 §4, §6): always an attachment, never rendered -- an uploaded .html
// must not become stored XSS -- under the name the Amiga gave it.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { getUpload, usableBlob } from '@/lib/amiga-uploads';
import { contentDisposition } from '@/lib/download-name';
import { diskStore } from '@/lib/storage';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const { id } = await ctx.params;
  const row = await getUpload(getDb(), orgId, id);
  const sha = row && usableBlob(row);
  if (!row || !sha) return new Response('not found', { status: 404 });
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = new Uint8Array(await diskStore.read(sha)); } catch { return new Response('not found', { status: 404 }); }
  const base = row.path.split(/[/:]/).pop() || 'file';
  return new Response(bytes, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition(base),
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
    },
  });
}
