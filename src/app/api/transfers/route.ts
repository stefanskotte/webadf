// Send to Amiga from the web (PaulaNET Phase 4 increment 3, spec 2026-10-16 §4). GET: the board's queue and its
// receiver state, for the Upload page. POST: one file from the computer, as a raw body (R13), stored by sha-256 in
// the disk store (R2) and queued for the board. DELETE: "Clear finished", the board's finished and lapsed rows.
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { clearFinishedTransfers, listTransfers, queueTransferFromBlob } from '@/lib/transfers';
import { findSendTarget } from '@/lib/send-targets';
import { SEND_FILE_MAX } from '@/lib/send-limits';
import { readCapped } from '@/lib/read-capped';
import { queueResponse, storeSendBytes, toView } from '@/lib/send-http';

export const maxDuration = 60;

/** The request body, or null as soon as it passes `max` bytes (the rest is cancelled unread). */
export async function GET(request: Request) {
  const { orgId } = await requireOrg();
  const deviceId = new URL(request.url).searchParams.get('deviceId');
  if (!deviceId) return Response.json({ error: 'invalid_query' }, { status: 400 });
  const db = getDb();
  const now = Date.now();
  const target = await findSendTarget(db, orgId, deviceId, now);
  if (!target) return Response.json({ error: 'no_device' }, { status: 404 });
  const rows = await listTransfers(db, orgId, deviceId);
  return Response.json({ target, transfers: rows.map((r) => toView(r, now)), now }, { headers: { 'cache-control': 'no-store' } });
}

/** Clear finished: scoped like GET (a board of another org is 404); the rows the page shows as finished go. */
export async function DELETE(request: Request) {
  const { orgId } = await requireOrg();
  const deviceId = new URL(request.url).searchParams.get('deviceId');
  if (!deviceId) return Response.json({ error: 'invalid_query' }, { status: 400 });
  const db = getDb();
  const now = Date.now();
  if (!(await findSendTarget(db, orgId, deviceId, now))) return Response.json({ error: 'no_device' }, { status: 404 });
  const deleted = await clearFinishedTransfers(db, orgId, deviceId, new Date(now));
  return Response.json({ deleted }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const { orgId, userId } = await requireOrg();
  const q = new URL(request.url).searchParams;
  const deviceId = q.get('deviceId');
  const name = q.get('name');
  if (!deviceId || !name) return Response.json({ error: 'invalid_query' }, { status: 400 });
  // Fast path: a declared length over the cap is refused before a byte is read. A body with no declared length
  // (chunked) is counted as it is read, below, and abandoned at the cap, so no route buffers more than 4 MB.
  if (Number(request.headers.get('content-length') ?? 0) > SEND_FILE_MAX) {
    return Response.json({ error: 'too_large' }, { status: 413 });
  }
  const db = getDb();
  if (!(await findSendTarget(db, orgId, deviceId))) return Response.json({ error: 'no_device' }, { status: 404 });
  const bytes = await readCapped(request, SEND_FILE_MAX);
  if (!bytes) return Response.json({ error: 'too_large' }, { status: 413 });
  if (bytes.byteLength === 0) return Response.json({ error: 'empty' }, { status: 400 });
  const sha256 = await storeSendBytes(bytes);
  return queueResponse(await queueTransferFromBlob(db, { orgId, deviceId, userId, path: name, sha256, bytes }));
}
