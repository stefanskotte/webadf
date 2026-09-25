import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { stableId } from '@/lib/ingest';
import { requestNfcWrite, cancelNfcWrite, readWriteResult } from '@/lib/nfc/store';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Task 8: the server-side half of NFC tap-to-mount (spec 2026-09-25 §5),
// driven the same way device-poll.spec.ts and device-status.spec.ts drive
// the rest of the device protocol -- real HTTP against a real dev server, no
// hardware involved.
test.afterAll(cleanupSeeded);

test('a tap mounts', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const title = `Tap Mount ${runTag()}`;
  const { diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(runTag()) });

  const res = await request.post('/api/device/tap', {
    headers: authHeader(token), data: { diskId },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ outcome: 'mounting', title });

  const poll = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(poll.desired.diskId).toBe(diskId);
});

test('the same tag again is already, and the desired version does not move', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const title = `Same Tag ${runTag()}`;
  const { diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(runTag()) });

  const first = await request.post('/api/device/tap', { headers: authHeader(token), data: { diskId } });
  expect(first.status()).toBe(200);
  expect((await first.json()).outcome).toBe('mounting');
  const before = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();

  // Past the 1 s rate limit, so this is a real second decision, not the burst
  // case the next test covers.
  await new Promise((r) => setTimeout(r, 1100));

  const second = await request.post('/api/device/tap', { headers: authHeader(token), data: { diskId } });
  expect(second.status()).toBe(200);
  expect((await second.json()).outcome).toBe('already');

  const after = await (await request.get('/api/device/poll?since=0', { headers: authHeader(token) })).json();
  expect(after.version).toBe(before.version);
});

test('a burst is ignored', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Burst ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const first = await request.post('/api/device/tap', { headers: authHeader(token), data: { diskId } });
  expect(first.status()).toBe(200);
  expect((await first.json()).outcome).toBe('mounting');

  // Immediately again, well inside the 1 s rate limit -- decideTap must
  // refuse this before it ever looks at which disk was named.
  const second = await request.post('/api/device/tap', { headers: authHeader(token), data: { diskId } });
  expect(second.status()).toBe(200);
  expect(await second.json()).toEqual({ outcome: 'ignored' });
});

test("another org's disk is indistinguishable from an unknown one", async ({ page, request, browser }) => {
  await signUpFresh(page);
  const { token } = await pairDevice(page, request);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const { orgId: orgB } = await signUpFresh(pageB);
  const { diskId: foreignDiskId } = await seedDisk(orgB, {
    title: `Foreign ${runTag()}`, diskNo: 1, sha256: sha(runTag()),
  });

  const foreignRes = await request.post('/api/device/tap', {
    headers: authHeader(token), data: { diskId: foreignDiskId },
  });
  expect(foreignRes.status()).toBe(200);
  const foreignBody = await foreignRes.json();
  expect(foreignBody).toEqual({ outcome: 'not_found' });

  // Past the 1 s rate limit so the second tap is a real decision, not a
  // burst -- decideTap must see 'not_found' on its own merits both times.
  await new Promise((r) => setTimeout(r, 1100));

  // A well-formed id (stableId's own shape) that nothing ever inserted.
  const unknownDiskId = stableId('e2e-nfc-tap-unknown', runTag());
  const unknownRes = await request.post('/api/device/tap', {
    headers: authHeader(token), data: { diskId: unknownDiskId },
  });
  expect(unknownRes.status()).toBe(200);
  const unknownBody = await unknownRes.json();
  expect(unknownBody).toEqual({ outcome: 'not_found' });

  // D4: a foreign disk and an unknown one must be byte-identical -- the org
  // always comes from requireDevice, never from the body or the tag.
  expect(foreignBody).toEqual(unknownBody);

  await ctxB.close();
});

test('a write round trip', async ({ page, request }) => {
  // The one poll in this spec that actually holds (nfcAck caught up, no
  // mount and no firmware pending to wake it early) -- the default 30 s test
  // timeout leaves no slack once setup and the 25 s hold are both counted.
  test.setTimeout(60_000);

  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const title = `Write ${runTag()}`;
  const { diskId } = await seedDisk(orgId, { title, diskNo: 1, sha256: sha(runTag()) });

  const seq = await requestNfcWrite(orgId, deviceId, diskId, new Date());
  expect(seq).not.toBeNull();

  // Behind on nfcAck: the request is delivered right away.
  const woke = await request.get(`/api/device/poll?nfcAck=0`, { headers: authHeader(token) });
  expect(woke.status()).toBe(200);
  const wokeBody = await woke.json();
  expect(wokeBody.nfcWrite).toEqual({ seq, diskId, title });

  // Caught up on nfcAck, nothing else pending: the poll holds the full 25 s
  // and returns 204, exactly like any other quiescent poll.
  const startedAt = Date.now();
  const held = await request.get(`/api/device/poll?nfcAck=${seq}`, {
    headers: authHeader(token), timeout: 45_000,
  });
  const elapsedMs = Date.now() - startedAt;
  expect(held.status()).toBe(204);
  expect(elapsedMs).toBeGreaterThanOrEqual(20_000);

  const write = await request.post('/api/device/tap-write', {
    headers: authHeader(token), data: { seq, ok: true, uid: '24:19:b6:01' },
  });
  expect(write.status()).toBe(200);
  expect(await write.json()).toEqual({ stored: true });

  // The same answer again is not stored a second time -- only the first
  // answer to the current request counts.
  const again = await request.post('/api/device/tap-write', {
    headers: authHeader(token), data: { seq, ok: true, uid: '24:19:b6:01' },
  });
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual({ stored: false });

  const result = await readWriteResult(deviceId, seq!);
  expect(result?.result).toBe('ok');
  expect(result?.uid).toBe('24:19:b6:01');
});

test('a cancel reaches the board', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const { diskId } = await seedDisk(orgId, { title: `Cancel ${runTag()}`, diskNo: 1, sha256: sha(runTag()) });

  const seq = await requestNfcWrite(orgId, deviceId, diskId, new Date());
  expect(seq).not.toBeNull();
  await cancelNfcWrite(deviceId, seq!);

  // The board's cursor is still at the OLD ack (0) -- it never learned about
  // the request before it was cancelled. The poll must still wake it, and
  // the disarm (diskId null) is what lets nfcAck catch up.
  const res = await request.get('/api/device/poll?nfcAck=0', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.nfcWrite).toBeDefined();
  expect(body.nfcWrite.diskId).toBeNull();
});

test('the reader state is stored', async ({ page, request }) => {
  await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);

  const res = await request.post('/api/device/status', {
    headers: authHeader(token), data: { mountedSha256: null, nfcReader: 'present' },
  });
  expect(res.status()).toBe(204);

  const [row] = await getDb().select({ nfcReader: devices.nfcReader })
    .from(devices).where(eq(devices.id, deviceId));
  expect(row.nfcReader).toBe('present');
});
