import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { pairDevice, seedDisk, authHeader, cleanupSeeded } from './device-helpers';
import { LIVE_POLL_MS, LIVE_IDLE_POLL_MS, LIVE_IDLE_AFTER_MS } from '@/lib/live-poll';

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

      // Wait for B to actually show the mount (the holder line DiskRow renders
      // once some device isThisDisk) BEFORE flipping write-protect below.
      // Without this, the mount's own refresh and the WP-driven refresh could
      // land in the same render -- or the mount's refresh could still be
      // pending when the WP assertion below happens to pass -- so the WP
      // assertion would not actually prove the write-protect change is what
      // caused B's refresh, only that SOME refresh eventually reflected both.
      await expect(pageB.getByTestId(`holder-${diskId}`)).toBeVisible(LIVE);

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

      // LiveRefresh's baseline is now the fingerprint the server already
      // computed for this render (the `initial` prop -- see the component's
      // doc comment), not whatever its first client fetch happens to see, so
      // that fetch DOES compare against it like any other tick. What this
      // still waits for is simpler: that the effect has actually started
      // polling at all. Client hydration can lag behind the server-rendered
      // HTML Playwright already sees above, and if the status report below
      // landed before LiveRefresh's first tick ever ran, that first tick
      // would see the post-change fingerprint, compare it against the
      // server-seeded baseline, and still refresh correctly -- but then the
      // wait below for the error text would be timing the hydration delay,
      // not the poller, which is not what this test means to measure.
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
  // 15 s, so the poller must keep polling (>= 3 ticks at a 3 s interval, with
  // margin: against the live production database the effective period is
  // 3 s plus a round trip, so a 10 s window could land exactly on 2 with no
  // slack) but never re-render (0 RSC requests) -- the detector just proved
  // it would catch a real change, so this silence is evidence, not an
  // unproven assumption.
  polls = 0; rsc = 0;
  await page.waitForTimeout(15_000);
  expect(polls).toBeGreaterThanOrEqual(3);
  expect(rsc).toBe(0);
});

test('an idle tab slows its live-state polling after ten minutes, and a real input restores the fast rate',
  async ({ page }) => {
    // Real time would make this test take 10+ minutes for nothing: Playwright's
    // clock lets the tab's own `performance.now()`/`Date.now()` jump straight
    // past the idle threshold. It has to be installed before ANY navigation,
    // not just before the assertions below -- LiveRefresh reads
    // performance.now() once at mount (`lastInputAt`'s initial value), and
    // installing the clock AFTER that mount rebases performance.now() to a
    // fresh near-zero epoch (confirmed by hand: a value read moments before
    // install() reads back near 0 immediately after), making every later
    // `now - lastInputAt` comparison meaningless. signUpFresh's own
    // navigation (to /sign-up, outside the (app) layout, which never mounts
    // LiveRefresh) happens after this, so the clock is already live for the
    // whole session by the time LiveRefresh first mounts on /library.
    //
    // fastForward() is used throughout rather than runFor(): fastForward is
    // the "closed the laptop lid" primitive, firing whatever timer was
    // already due exactly once and leaving the clock at the new time, which
    // is exactly what simulating "ten minutes with nobody touching the tab"
    // needs. runFor() instead walks the clock forward tick by tick -- but
    // each tick here does a REAL fetch to a REAL server, and runFor's own
    // advance does not itself wait in real wall-clock time for that fetch to
    // land (confirmed by hand: a recursive setTimeout chain whose callback
    // does a genuine network fetch left every tick's fetch permanently
    // in-flight under runFor, since it raced ahead of the real time that
    // fetch needed -- and every following tick then found `inFlight.current`
    // still true and silently no-opped). fastForward avoids this by firing
    // at most one real fetch per call, which this test then explicitly waits
    // for in real time (`page.waitForResponse`/`expect.poll`) before the next
    // jump, giving `check()`'s `finally { inFlight.current = false }` and
    // `arm()`'s re-scheduling a real chance to run first.
    //
    // Each phase is sized to be sensitive to the actual scheduled delay, not
    // just to "some tick eventually happens": a jump smaller than the fast
    // rate proves silence, one past the fast rate but short of the slow rate
    // proves "not fast", and one further still proves "genuinely slow" -- so
    // a regression that left the rate always fast (or dropped the slow rate
    // entirely) fails a `toBe(0)` here rather than an easily-satisfied lower
    // bound.
    test.setTimeout(60_000);
    await page.clock.install({ time: Date.now() });
    await signUpFresh(page);

    let polls = 0;
    page.on('request', (r) => { if (r.url().includes('/api/live-state')) polls++; });

    function nextPoll() {
      return page.waitForResponse((r) => r.url().includes('/api/live-state'), { timeout: 10_000 });
    }

    // Let the dev server's Strict-Mode double-mount settle: its first,
    // discarded effect instance still fires one real fetch before its
    // cleanup runs, and that fetch's `finally` must clear `inFlight.current`
    // (a ref shared with the surviving instance) before this test starts
    // driving the clock, or the surviving instance's very first tick would
    // find it still busy and silently skip.
    await page.waitForTimeout(2_000);

    // Active: a small jump (a bit over the fast rate) must land a real poll.
    polls = 0;
    {
      const resp = nextPoll();
      await page.clock.fastForward(LIVE_POLL_MS + 1_000);
      await resp;
    }
    expect(polls).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300); // let the tick's `finally { arm() }` re-schedule before the next jump

    // Jump past the ten-minute idle threshold in one step. Whatever was
    // still scheduled at the fast rate fires once; the `arm()` inside that
    // tick recomputes the delay against the now-far-future clock and
    // re-arms at the slow rate.
    {
      const resp = nextPoll();
      await page.clock.fastForward(LIVE_IDLE_AFTER_MS + 60_000);
      await resp;
    }
    await page.waitForTimeout(300);

    // Not fast any more: the same small jump that landed a poll while active
    // must land NOTHING now -- if the idle rate rule were ever removed (or
    // `livePollDelay` always returned the fast rate), this tick would still
    // be scheduled at 3 s and this assertion would catch it.
    polls = 0;
    await page.clock.fastForward(LIVE_POLL_MS + 1_000);
    await page.waitForTimeout(800); // real settle: long enough for a wrongly-fast tick's fetch to be dispatched
    expect(polls).toBe(0);

    // Genuinely slow: advancing the rest of the way to the 30 s mark lands
    // the poll the fast-only jump above proved was NOT already scheduled.
    {
      const resp = nextPoll();
      await page.clock.fastForward(LIVE_IDLE_POLL_MS);
      await resp;
    }
    await page.waitForTimeout(300);

    // A real input -- an actual mouse move dispatched over the page, not a
    // simulated clock tick -- must poll at once rather than wait out the
    // rest of the 30 s already scheduled. Waited for as a full response, not
    // just the request firing, so `arm()` (which only re-schedules once this
    // immediate `check()` resolves) has actually run before the next jump.
    polls = 0;
    {
      const resp = nextPoll();
      await page.mouse.move(200, 200);
      await resp;
    }
    expect(polls).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300);

    // Genuinely fast again, not just a one-off catch-up poll: the same small
    // jump that proved silence while idle must now land a poll.
    polls = 0;
    await page.clock.fastForward(LIVE_POLL_MS + 1_000);
    await page.waitForTimeout(800);
    expect(polls).toBeGreaterThanOrEqual(1);
  });
