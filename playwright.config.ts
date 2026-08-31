import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
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
