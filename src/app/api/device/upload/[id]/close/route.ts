// Closes an upload from the Amiga (spec 2026-10-18 §4): the CRC-32 Receive computed over the whole file. A 4 MB close
// reads 256 chunk rows (Task 12 timed it). A row deleted or expired mid-close answers 404 gone. A repeat with the same
// CRC (a lost answer, or the board's retry while the first close runs) answers as the first did: the name, or crc.
import { z } from 'zod';
import { getDb } from '@/db';
import { requireDevice, deviceAuthResponse } from '@/lib/device-auth';
import { closeUpload } from '@/lib/amiga-uploads';
import { placeFetched } from '@/lib/files/net-fetch';

export const maxDuration = 60;

const body = z.object({ crc32: z.number().int().min(0).max(0xFFFFFFFF) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  let device;
  try {
    device = await requireDevice(request);
  } catch (e) {
    const res = deviceAuthResponse(e);
    if (res) return res;
    throw e;
  }
  const { id } = await ctx.params;
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ code: 'server' }, { status: 400 });
  }
  const p = body.safeParse(json);
  if (!p.success) return Response.json({ code: 'server' }, { status: 400 });
  const db = getDb();
  const r = await closeUpload(db, device.deviceId, id, p.data.crc32);
  if (r.ok) {
    // A file a Files copy fetched (NET: volumes §4.5) is placed now (a repeat close finds its get settled already).
    await placeFetched(db, id);
    return Response.json({ name: r.name }, { headers: { 'cache-control': 'no-store' } });
  }
  return Response.json({ code: r.code }, { status: r.status });
}
