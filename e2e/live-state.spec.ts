import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';

test.afterAll(cleanupSeeded);

// The 3 s interval plus a request and a re-render. Anything slower is a bug.
const LIVE = { timeout: 5_000 };

/** Browser A signs up; browser B signs in as the same user and never reloads. */
async function twoBrowsers(browser: Browser, pageA: Page) {
  const { email, password, orgId } = await signUpFresh(pageA);
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto('/sign-in');
  await pageB.getByLabel('Email').fill(email);
  await pageB.getByLabel('Password').fill(password);
  await pageB.getByRole('button', { name: 'Sign in' }).click();
  await expect(pageB).toHaveURL(/\/library/, { timeout: 15_000 });
  return { orgId, pageB, closeB: () => ctxB.close() };
}

async function diskFor(orgId: string) {
  const sha = createHash('sha256').update(`live-${runTag()}-${Math.random()}`).digest('hex');
  const { gameId, diskId } = await seedDisk(orgId, { title: `Live ${runTag()}`, diskNo: 1, sha256: sha });
  return { gameId, diskId, sha };
}

test('a mount made in one browser, and the board converging, show in another without a reload',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    try {
      const { deviceId, token } = await pairDevice(page, request);
      const { diskId, sha } = await diskFor(orgId);
      await pageB.goto('/devices');
      const card = pageB.getByTestId(`device-${deviceId}`);
      await expect(card).toHaveAttribute('data-state', 'empty');

      const mounted = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
      expect(mounted.status()).toBe(200);
      const { version } = await mounted.json();
      // A never-polled device has lastSeenAt = null, which reads as 'stale' (never
      // seen), not 'pending'. A real board polls roughly every 25 s; here a single
      // poll -- since=0 is already behind the version the mount just produced, so
      // it returns immediately rather than holding -- establishes it as seen,
      // exactly as e.g. device-protocol.spec.ts's "establish it saw the mount" does.
      await request.get('/api/device/poll?since=0', { headers: authHeader(token) });
      await expect(card).toHaveAttribute('data-state', 'pending', LIVE);

      expect((await request.post('/api/device/status', {
        headers: authHeader(token), data: { mountedSha256: sha, mountedDiskId: diskId, version },
      })).status()).toBe(204);
      await expect(card).toHaveAttribute('data-state', 'converged', LIVE);
    } finally {
      await closeB();
    }
  });

test('write-protect changed in one browser shows in another without a reload',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    try {
      const { deviceId } = await pairDevice(page, request);
      const { gameId, diskId } = await diskFor(orgId);
      // B loads the game page BEFORE the mount below, while the paired device is
      // still 'empty' (nothing desired yet). Until it was deleted (this task's
      // predecessor), games/[id]/page.tsx also mounted an older, unrelated
      // src/components/devices/live-refresh.tsx with active={anyPending} -- a
      // blind interval timer with no fingerprint check at all, unlike the new
      // global poller this spec proves. Had B's FIRST render already seen a
      // pending/stale device back then, that old timer would have started
      // ticking on its own and could have made this assertion pass for a
      // reason that had nothing to do with the new poller. Loading before the
      // mount kept that prop false at mount time, so its effect never started
      // a timer. The component is gone now, but this ordering is still sound
      // and still isolates the new global fingerprint poller as the only thing
      // that can refresh this page.
      await pageB.goto(`/games/${gameId}`);
      const toggle = pageB.getByTestId(`wp-${diskId}`);
      await expect(toggle).toHaveAttribute('data-protected', 'true');

      // Watched only for a disk a device has asked for (spec §6).
      expect((await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } })).status()).toBe(200);

      expect((await page.request.patch(`/api/disks/${diskId}`, { data: { writeProtected: false } })).status()).toBe(200);
      await expect(toggle).toHaveAttribute('data-protected', 'false', LIVE);
    } finally {
      await closeB();
    }
  });

test('a status report carrying only a new error shows in another browser without a reload',
  async ({ browser, page, request }) => {
    const { pageB, closeB } = await twoBrowsers(browser, page);
    try {
      const { deviceId, token } = await pairDevice(page, request);
      // No poll needed to establish "seen" here, unlike the mount test above:
      // nothing is ever desired or mounted on this device, so deviceState()
      // stays 'empty' regardless of lastSeenAt -- 'stale' only applies once
      // desired and mounted diverge. (A since=0 poll before any version bump
      // would also hold for the full 25 s HOLD_MS with nothing to report,
      // which is not what "establish seen" is for.)
      await pageB.goto('/devices');
      const card = pageB.getByTestId(`device-${deviceId}`);
      await expect(card).toHaveAttribute('data-state', 'empty');
      await expect(pageB.getByTestId(`device-error-${deviceId}`)).toHaveCount(0);

      // LiveRefresh's FIRST /api/live-state fetch only records a baseline and
      // never compares (see its `last.current === null` branch) -- it never
      // refreshes off of it. If that baseline fetch is still in flight (client
      // hydration can lag behind the server-rendered HTML Playwright already
      // sees above) when the status report below lands, the baseline itself
      // would already be the POST-change fingerprint, and the poller would
      // have nothing left to notice: no comparison ever sees a diff, and this
      // test would hang on a change that already happened. Waiting for that
      // first request here, before making the change, is the same guard the
      // idle test below applies for the same reason.
      await pageB.waitForResponse((r) => r.url().includes('/api/live-state'));

      const message = `SPI timeout ${runTag()}`;
      // Per the status route's schema (src/app/api/device/status/route.ts),
      // mountedSha256 is required but nullable -- null here reports "still
      // holding nothing", exactly this never-mounted device's actual state,
      // so `error` is the only thing that actually changes.
      expect((await request.post('/api/device/status', {
        headers: authHeader(token), data: { mountedSha256: null, error: message },
      })).status()).toBe(204);

      await expect(pageB.getByTestId(`device-error-${deviceId}`)).toHaveText(message, LIVE);
    } finally {
      await closeB();
    }
  });

test('a change landing between the server render and the client\'s first poll is not lost',
  async ({ browser, page, request }) => {
    const { orgId, pageB, closeB } = await twoBrowsers(browser, page);
    try {
      const { deviceId, token } = await pairDevice(page, request);
      const { diskId } = await diskFor(orgId);

      // Hold ONLY B's first /api/live-state request -- every later one goes
      // through untouched -- for long enough (3 s) that a real change can
      // land in the exact window this task's fix closes: between the
      // server's render of B's /devices page (LiveRefresh's `initial` prop,
      // captured the instant before this intercept is even installed) and
      // the client's first comparison tick. Before the fix, that first tick
      // only RECORDED whatever it saw as the baseline and never compared --
      // so a change already reflected in it would be silently adopted as
      // "nothing changed" and never shown until some OTHER, later change
      // gave the poller something new to notice (never, in this test).
      let heldOnce = false;
      await pageB.route('**/api/live-state', async (route) => {
        if (!heldOnce) {
          heldOnce = true;
          await new Promise((r) => setTimeout(r, 3_000));
        }
        await route.continue();
      });

      await pageB.goto('/devices');
      const card = pageB.getByTestId(`device-${deviceId}`);
      await expect(card).toHaveAttribute('data-state', 'empty');

      // While that first request is still held (route.continue() has not
      // even dispatched it to the network yet), make the real change from
      // browser A: mount a disk, then establish the device as seen -- the
      // mount above already bumped the version past `since=0`, so this poll
      // returns immediately rather than holding -- so it reads 'pending',
      // not 'stale'.
      const mounted = await page.request.post(`/api/devices/${deviceId}/mount`, { data: { diskId } });
      expect(mounted.status()).toBe(200);
      await request.get('/api/device/poll?since=0', { headers: authHeader(token) });

      // 8 s: the 3 s hold plus the same 5 s budget every other live test in
      // this file gets, for the fetch, comparison and re-render that follow.
      await expect(card).toHaveAttribute('data-state', 'pending', { timeout: 8_000 });
    } finally {
      await closeB();
    }
  });

test('the fingerprint poller re-renders on a real change and does nothing while idle', async ({ page, request }) => {
  await signUpFresh(page);
  // This device stays untouched for the whole test -- what makes the idle
  // half of this test idle. It also renders the devices page's first card,
  // which is 'empty' at this, the only browser's, first render, so back when
  // the older devices/live-refresh.tsx still existed (see the write-protect
  // test above), it never started its own timer to be mistaken for the new
  // poller. That component is deleted now; this ordering is kept regardless.
  await pairDevice(page, request);
  await page.goto('/devices');
  let polls = 0, rsc = 0;
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/live-state')) polls++;
    if (url.includes('_rsc=') || r.headers()['rsc'] === '1') rsc++;
  });

  // Prove the rsc detector actually fires before trusting its silence below:
  // an untouched counter proves nothing if it can never go non-zero. Pairing a
  // SECOND device changes this org's fingerprint by exactly one row -- and,
  // deliberately, leaves both devices 'empty' (nothing mounted or desired), so
  // it could never have started the older devices/live-refresh.tsx's blind
  // timer (now deleted) and confounded the idle measurement that follows.
  // Within one poll window (LIVE_POLL_MS) the new poller's router.refresh()
  // must show up as a real RSC request.
  await pairDevice(page, request, 'Second Device');
  await expect.poll(() => rsc, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  // Let any requests the refresh itself triggered settle before the clean
  // measurement below, so they cannot be counted as idle-window noise.
  await page.waitForTimeout(1_000);

  // Now measure the idle baseline with a clean slate: nothing changes for
  // 10 s, so the poller must keep polling (>= 2 ticks at a 3 s interval) but
  // never re-render (0 RSC requests) -- the detector just proved it would
  // catch a real change, so this silence is evidence, not an unproven assumption.
  polls = 0; rsc = 0;
  await page.waitForTimeout(10_000);
  expect(polls).toBeGreaterThanOrEqual(2);
  expect(rsc).toBe(0);
});
