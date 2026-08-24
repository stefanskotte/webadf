import { type Page, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Playwright's own test process (as opposed to the `pnpm dev` webServer it
// spawns) never gets .env.local loaded automatically — Next.js only does
// that for its own process. Tests that need to assert on real DB state
// (ingest-api.spec.ts's idempotency/tenancy tests) import `@/db` directly,
// so this makes DATABASE_URL etc. available before that import runs.
// Safe to call more than once; safe in CI where real env vars are already
// set instead of a .env.local file.
function loadEnvLocal() {
  try {
    const content = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env.local (e.g. CI with real env vars already exported) — fine.
  }
}
loadEnvLocal();

export async function signUpFresh(page: Page) {
  const email = `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = 'correct-horse-battery-staple';

  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/library/, { timeout: 15_000 });

  const orgId = await page.getByTestId('active-org').textContent();
  return { email, password, orgId: orgId ?? '' };
}
