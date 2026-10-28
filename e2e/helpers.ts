import { type Page, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * The server under test, as playwright.config.ts picks it: BASE_URL (an existing server: the self-host stack, or the
 * hosted site) or the dev server on PORT. Share links carry this origin, so the sharing specs check against it.
 */
export const TARGET = new URL(process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A share link on the server under test: `<origin>/s/wfsc_…`. */
export const SHARE_LINK_RE = new RegExp(`^${escapeRe(TARGET.origin)}/s/wfsc_[A-Za-z0-9_-]{43}$`);

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

// better-auth's production rate limit allows 3 sign-ups per 10 s per client. The dev server the suite normally
// runs against is not in production mode and has no limit; the self-hosting stack (scripts/docker-e2e.sh) is, and
// has. With E2E_SIGNUP_GAP_MS set, sign-ups are spaced at least that far apart ACROSS spec files (the last one is
// kept in a file, because each spec file gets its own module instance), and a sign-up the limiter still refuses
// is retried once the window has passed. Unset (0), nothing waits and nothing is retried.
const SIGNUP_STAMP = join(tmpdir(), 'webadf-e2e-last-signup');
export async function paceSignUp(gapMs = Number(process.env.E2E_SIGNUP_GAP_MS ?? 0)) {
  if (!(gapMs > 0)) return;
  let last = 0;
  try { last = Number(readFileSync(SIGNUP_STAMP, 'utf8')) || 0; } catch { /* first sign-up of the run */ }
  const wait = last + gapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  writeFileSync(SIGNUP_STAMP, String(Date.now()));
}

export async function signUpFresh(page: Page) {
  await paceSignUp();
  const email = `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = 'correct-horse-battery-staple';
  const inviteCode = await mintInviteCode();

  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Invite code').fill(inviteCode);
  await page.getByRole('button', { name: 'Create account' }).click();
  if (Number(process.env.E2E_SIGNUP_GAP_MS ?? 0) > 0) {
    const refused = page.getByRole('alert').filter({ hasText: /Too many/ });
    if (await refused.waitFor({ timeout: 4_000 }).then(() => true, () => false)) {
      await paceSignUp(10_500);
      await page.getByRole('button', { name: 'Create account' }).click();
    }
  }
  await expect(page).toHaveURL(/\/library/, { timeout: 15_000 });

  const orgId = await page.getByTestId('active-org').textContent();
  if (orgId) signedUpOrgIds.push(orgId);
  return { email, password, inviteCode, orgId: orgId ?? '' };
}

/**
 * Make a blank disk from the library header's "Create ADF" panel.
 *
 * Every caller goes through here because the trigger click alone creates
 * nothing: it opens a small form (Size, Filesystem, Create). Both switches
 * are clicked every time, even for the defaults, so a caller states the disk
 * it wants rather than relying on what the panel happens to show. The panel
 * resets to 880 KB / FFS on each open, but that reset is what
 * create-adf.spec.ts tests -- it is not something every other spec should
 * lean on silently. Keeping the steps in one place stops a caller forgetting
 * the Create click and leaving a panel open with no disk made.
 */
export async function createAdf(page: Page, filesystem: 'FFS' | 'OFS' = 'FFS', density: 'dd' | 'hd' = 'dd') {
  // A click on the server-rendered button before React has hydrated it does nothing, and the panel never opens
  // (archive-drop-folder flake, 2026-10-25: no game card after createAdf). Hydrated nodes carry `__reactProps$…`.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="create-adf"]');
    return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
  });
  await page.getByTestId('create-adf').click();
  await page.getByTestId(`create-adf-size-${density}`).click();
  await page.getByTestId(`create-adf-fs-${filesystem.toLowerCase()}`).click();
  // Wait for the server's answer so a slow create reads as slow, not as "no game card" five seconds later.
  const created = page.waitForResponse((r) => r.url().includes('/api/disks/create') && r.request().method() === 'POST');
  await page.getByTestId('create-adf-submit').click();
  expect((await created).status()).toBe(200);
}

// ---- The Upload page's Staging list (A6, spec 2026-10-23 §4 "Test ids") ----

/** The library rows ("↓ To library") of the Staging list, newest first. */
export const libRows = (page: Page) => page.locator('[data-testid="staging-row"][data-kind="lib"]');

/**
 * Waits until the Upload page has hydrated: a synthetic pick or drop on server-rendered HTML has no handler yet and
 * silently does nothing. The server render says "Reading the list…"; an empty text or a row exists only once the
 * client has run (as dropAdf in upload-staging.spec.ts does).
 */
export async function stagingReady(page: Page) {
  await expect(page.locator('[data-testid="staging-empty"], [data-testid="staging-row"]').first())
    .toBeVisible({ timeout: 15_000 });
}

// ---- The library's ⋯ title menu (Phase C1, spec 2026-10-24 §2) ----

/**
 * Opens a card's or a row's ⋯ menu and waits for its popup. The items (`card-mount-<id>`, `fob-<id>`,
 * `history-<id>`, `move-to-collection-<id>`, `remove-from-collection-<id>`, `delete-game-<id>`) are then picked at
 * PAGE level: the popup is portalled to <body>, so a locator scoped to the card or row does not reach them. Their
 * ids carry the game id, so they are unique on the page.
 *
 * Taps on a touch context (the mobile project), clicks elsewhere. Playwright does not expose a context's
 * `hasTouch`, so it is read where it lands: Chromium reports touch points only when the context has touch.
 */
export async function openTitleMenu(page: Page, gameId: string) {
  const trigger = page.getByTestId(`title-menu-${gameId}`);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) await trigger.tap();
  else await trigger.click();
  const panel = page.getByTestId('title-menu-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Opens a disk file row's ⋯ menu (C4 spec §5.3) -- by block number, or by the row's name -- and returns the panel.
 * The row actions (Download, Send to Amiga, Rename, Move to…, Protection bits…, Delete) are items in it and keep
 * their old test ids. A tap where the page has touch, a click otherwise (same rule as openTitleMenu).
 */
export async function openRowMenu(page: Page, row: number | string) {
  const trigger = typeof row === 'number'
    ? page.getByTestId(`fs-more-${row}`)
    : page.locator(`[data-testid="fs-entry"][data-name="${row}"] [data-testid^="fs-more-"]`);
  // A press before hydration reaches DOM with no handler: wait for the trigger's own React props.
  await expect.poll(() => trigger.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps$')
    && typeof (el as unknown as Record<string, Record<string, unknown>>)[k]?.onPointerDown === 'function'))).toBe(true);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) await trigger.tap();
  else await trigger.click();
  const panel = page.getByTestId('fs-row-menu');
  await expect(panel).toBeVisible();
  return panel;
}

/** Opens one version in a disk's History (C4 spec §7.2) unless it is open already; versions collapse by default. */
export async function openVersion(page: Page, seq: number) {
  const toggle = page.getByTestId(`version-toggle-${seq}`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId(`version-body-${seq}`)).toBeVisible();
}
