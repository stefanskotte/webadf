import { defineConfig } from '@playwright/test';

// The README screenshots (docs/screenshots/). NOT part of `pnpm e2e`: the
// capture lives in e2e/screenshots.shots.ts, and the default config only picks
// up *.spec.ts / *.test.ts, so it never runs with the suites.
//
// Run: PORT=3100 pnpm screenshots
//
// No globalTeardown on purpose. The suite's teardown removes EVERY
// @example.test account, including those of another e2e run that is still
// going against the same live database. The capture removes exactly the demo
// account it made, in its own afterAll; the next normal e2e run's teardown is
// the backstop if that ever fails.
const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /\.shots\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Uploading, then waiting for the app's own identification sweep, then
  // eight pages. Well over the suite's 30 s.
  timeout: 360_000,
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: BASE_URL,
    env: { PORT: String(PORT), BETTER_AUTH_URL: BASE_URL },
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
