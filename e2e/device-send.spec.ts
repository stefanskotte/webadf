// PaulaNET Phase 4 (spec 2026-10-16 §3-4): a file queued for a board, as the board sees it -- the poll's cursor, the
// queue text, the chunks and the outcome. The board's side is driven by hand, as the firmware does it.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { diskStore } from '@/lib/storage';
import { queueTransferFromBlob } from '@/lib/transfers';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, authHeader, cleanupSeeded } from './device-helpers';

// Deleting the paired devices cascades to their transfers rows.
test.afterAll(async () => { await cleanupSeeded(); });

test('a queued file reaches the board: cursor, queue, chunks, outcome', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const bytes = new Uint8Array(20_000).map((_, i) => (i * 31 + runTag().length) & 0xff);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (!(await diskStore.stat(sha))) await diskStore.put(sha, bytes);
  const q = await queueTransferFromBlob(getDb(), { orgId, deviceId, userId: 'e2e', path: 'Café.bin', sha256: sha });
  expect(q.ok).toBe(true);
  const id = (q as { id: string }).id;

  // An old board (no xferAck) is never sent the cursor.
  const old = await (await request.get('/api/device/poll?since=999999', { headers: authHeader(token) })).json();
  expect(old).not.toHaveProperty('xfer');
  // A 1.14 board is woken by the queue and told its version.
  const poll = await request.get('/api/device/poll?since=999999&xferAck=0&rx=c', { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  expect((await poll.json()).xfer.v).toBeGreaterThanOrEqual(1);

  const queue = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body());
  const text = queue.toString('latin1');
  expect(text.startsWith(`NEXT ${id} 20000 `)).toBe(true);
  expect(text).toContain('8:Café.bin');

  const c1 = await request.get(`/api/device/send/${id}?offset=0&length=16384`, { headers: authHeader(token) });
  const c2 = await request.get(`/api/device/send/${id}?offset=16384&length=16384`, { headers: authHeader(token) });
  expect(Buffer.concat([await c1.body(), await c2.body()]).equals(Buffer.from(bytes))).toBe(true);

  const done = await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: { ok: true, savedAs: 'Café.bin' } });
  expect(done.status()).toBe(204);
  const after = Buffer.from(await (await request.get('/api/device/send/queue', { headers: authHeader(token) })).body()).toString('latin1');
  expect(after).toBe('NEXT -\nLIST 0\n');
  // A repeat after a lost response is a 409, and the chunk route refuses a finished row.
  expect((await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: { ok: true, savedAs: 'x' } })).status()).toBe(409);
  expect((await request.get(`/api/device/send/${id}?offset=0&length=10`, { headers: authHeader(token) })).status()).toBe(409);
});

test('another board cannot read the file', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const a = await pairDevice(page, request, 'Board A');
  const b = await pairDevice(page, request, 'Board B');
  const bytes = new TextEncoder().encode(`secret ${runTag()}`);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (!(await diskStore.stat(sha))) await diskStore.put(sha, bytes);
  const q = await queueTransferFromBlob(getDb(), { orgId, deviceId: a.deviceId, userId: 'e2e', path: 'S', sha256: sha });
  const id = (q as { id: string }).id;
  expect((await request.get(`/api/device/send/${id}?offset=0&length=10`, { headers: authHeader(b.token) })).status()).toBe(404);
  expect((await request.get('/api/device/send/queue', { headers: authHeader(b.token) })).status()).toBe(200);
});
