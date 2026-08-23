import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // shared database
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
