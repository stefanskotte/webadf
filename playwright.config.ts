import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Runs once after the whole suite. Without it a single run left ~70 users,
  // orgs, games and disks in the live database permanently -- 4,600 rows had
  // accumulated before this existed -- plus every uploaded object, which
  // nothing had ever deleted. See e2e/global-teardown.ts for the safety
  // boundary.
  globalTeardown: './e2e/global-teardown.ts',
  // Both of these are needed, and the pair is easy to get wrong.
  //
  // fullyParallel: false only stops tests within ONE file running in
  // parallel. Across files Playwright still spins up workers (five on a
  // ten-core machine), so before `workers: 1` this suite ran five spec files
  // at once against one shared live database despite the comment below
  // claiming otherwise.
  //
  // That was survivable while no spec mutated global state. It stopped being
  // survivable when the TOSEC scan landed: importing a DAT deliberately
  // clears the match verdict on EVERY blob (see src/lib/tosec-import.ts), so
  // any two specs that sweep are mutually exclusive by design. Run them
  // concurrently and they reset each other's fixtures mid-sweep -- observed
  // as seven failures that all pass in isolation.
  fullyParallel: false, // shared database
  workers: 1,           // ...and one worker, for the reason above
  retries: 0,
  timeout: 30_000,
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  // Two projects, because until now the suite proved nothing about the width
  // it was most likely to be broken at. Everything ran at Playwright's DEFAULT
  // 1280x720 -- no viewport was ever configured -- so the responsive work had
  // no test that could fail.
  //
  // The desktop project deliberately sets NO viewport: it must keep inheriting
  // that same 1280x720 default, so every existing spec is measured against
  // exactly the layout it was written for. Every mobile rule in the app is
  // written as the unprefixed base with sm:/md: restoring the desktop value,
  // which means a regression here is the signal that a rule was written
  // backwards.
  projects: [
    {
      name: 'desktop',
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
      // isMobile turns on Chromium's meta-viewport emulation, and hasTouch is
      // what makes dnd-kit's TouchSensor reachable at all -- without it the
      // press-and-hold-to-drag test would silently exercise the mouse path
      // and prove nothing about a finger.
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    // Raised from the brief's 120_000: Turbopack's first cold compile of the
    // auth/library routes plus the Neon connection warmup can exceed two
    // minutes on a cold cache. This does not loosen any assertion — it only
    // gives the dev server more time to report ready.
    timeout: 240_000,
  },
});
