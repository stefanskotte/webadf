// Opens an upload from the Amiga (spec 2026-10-18 §4): the board relays Receive's PUT as JSON. The org and the board
// come from the device token, never from the body. The board escapes Latin-1 bytes as \u00XX, so JSON.parse already
// yields the right characters; openUpload cleans the path, and nothing here decodes again.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { openUpload } from '@/lib/amiga-uploads';

const body = z.object({
  size: z.number().int().min(0).max(0xFFFFFFFF),
  date: z.string().regex(/^\d{1,6}\.\d{1,5}\.\d{1,5}$/),
  protection: z.number().int().min(0).max(0xFFFFFFFF),
  path: z.string().min(1).max(1024),
  comment: z.string().max(400).default(''),
});
const STATUS = { size: 413, full: 409, name: 400 } as const;

export async function POST(request: Request) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ code: 'server' }, { status: 400 });
  }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ code: 'server' }, { status: 400 });
  const r = await openUpload(getDb(), device, p.data);
  if (!r.ok) return Response.json({ code: r.code }, { status: STATUS[r.code] });
  return Response.json({ id: r.id, offset: r.offset }, { headers: { 'cache-control': 'no-store' } });
}
