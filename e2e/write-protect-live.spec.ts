import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
test.afterAll(cleanupSeeded);

test('flipping write-protect reaches a board holding the disk, without a new digest', async ({ page, request }) => {
  const { orgId } = await signUpFresh(page);
  const { deviceId, token } = await pairDevice(page, request);
  const digest = sha(runTag());
  const { diskId } = await seedDisk(orgId, { title: `Wp ${runTag()}`, diskNo: 1, sha256: digest });
  const { version } = await (await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).json();

  expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);

  const poll = await request.get(`/api/device/poll?since=${version}`, { headers: authHeader(token) });
  expect(poll.status()).toBe(200);
  const body = await poll.json();
  expect(body.version).toBe(version + 1);
  expect(body.desired.sha256).toBe(digest);          // same bytes: the board does not re-fetch
  expect(body.desired.writeProtected).toBe(false);
});
