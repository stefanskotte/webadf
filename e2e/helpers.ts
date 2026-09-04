import { type Page, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueInvite } from '@/lib/invites';

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

/**
 * A per-run uniqueness suffix that can never be parsed as a disk number.
 *
 * The old `${Date.now()}-${Math.floor(Math.random() * 1e6)}` could draw 1-99,
 * and parseTosecName strips a trailing "-N" in that range as a disk number --
 * so roughly one run in ten thousand silently got a different title than the
 * one the locator searched for. The base-36 tail always contains at least one
 * non-digit ('r'), so the trailing-"-N" rule can never fire on it.
 */
export function runTag(): string {
  return `${Date.now()}r${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Registration is closed behind invite codes (D13). Seeding a row directly
 * via Drizzle -- rather than going through some other authenticated
 * "create an invite" flow -- avoids a chicken-and-egg problem: minting an
 * invite through the app would itself require an already-signed-up user
 * with an organization, which is exactly what every caller of
 * `signUpFresh` is trying to create in the first place. `orgId` and
 * `createdByUserId` are untracked, disposable placeholders here; nothing in
 * this task uses an invite's issuer/org for anything beyond bookkeeping.
 */
export async function mintInviteCode(): Promise<string> {
  return issueInvite('e2e-seed-org', 'e2e-seed-user');
}

/**
 * Every org signUpFresh created in THIS spec file.
 *
 * Playwright runs one module instance per spec file, so this list is exactly
 * that file's orgs -- the same scoping device-helpers' `seeded` registry uses.
 * Kept here, as a plain array with no database import, because helpers.ts must
 * not import anything that reaches `@/db`: loadEnvLocal() above runs at module
 * top level, AFTER imports are hoisted, so an import that touched the database
 * would evaluate before DATABASE_URL existed.
 *
 * Registered by signUpFresh itself rather than by each caller, so a spec
 * cannot forget. cleanupSeeded (device-helpers.ts) is what drains it.
 */
export const signedUpOrgIds: string[] = [];

export async function signUpFresh(page: Page) {
  const email = `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = 'correct-horse-battery-staple';
  const inviteCode = await mintInviteCode();

  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Invite code').fill(inviteCode);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/library/, { timeout: 15_000 });

  const orgId = await page.getByTestId('active-org').textContent();
  if (orgId) signedUpOrgIds.push(orgId);
  return { email, password, inviteCode, orgId: orgId ?? '' };
}

/**
 * Make a blank disk from the library header's "Create ADF" menu.
 *
 * Every caller goes through here because the trigger click alone no longer
 * creates anything. It used to: the control was a sticky <select> beside a
 * button, so a bare `create-adf` click made a disk using whatever filesystem
 * had last been selected -- including one selected by an earlier action. The
 * menu makes the filesystem part of the click instead of ambient state, and
 * that means a caller that forgets the second click leaves a menu open and no
 * disk made. Keeping the two-step in one place is what stops that being
 * rediscovered per spec.
 */
export async function createAdf(page: Page, filesystem: 'FFS' | 'OFS' = 'FFS') {
  await page.getByTestId('create-adf').click();
  await page.getByTestId(`create-adf-${filesystem.toLowerCase()}`).click();
}
