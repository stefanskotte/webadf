import { test, expect, type Page } from '@playwright/test';
import { signUpFresh } from './helpers';
import { signInAsSuperAdmin } from './admin-helpers';

/**
 * The nav pill never runs under the search box, nor into the wordmark / drive
 * chips on its left, at any desktop width, in either shell (Phase B final
 * review F1, 2026-10-24: the viewport-centred pill ran ~40px under the admin
 * search box at 1280, and the member pill ~55px under the app one at 1024 --
 * clicks on the hidden part went to the search input).
 *
 * The pill's box is its scroll clamp (the nav's parent), not the nav itself:
 * when space is short the nav may scroll inside that clamp, and only the
 * clamp's box is what is painted.
 */

const WIDTHS = [640, 768, 1024, 1180, 1280, 1440, 1536, 1920];

type Box = { left: number; right: number };

async function measure(page: Page, shell: 'app' | 'admin') {
  return page.evaluate((shell) => {
    const header = document.querySelector<HTMLElement>(`[data-testid="${shell}-header"]`)!;
    const nav = header.querySelector('nav')!;
    const clamp = nav.parentElement!.getBoundingClientRect();
    const search = header.querySelector('[data-testid="search-input"]')!.getBoundingClientRect();
    // Everything that sits left of the pill and is painted: the wordmark, and
    // in the app shell the chips or the compact Drives control.
    const left = shell === 'app'
      ? ['wordmark-home', 'drive-chips', 'drives-compact']
          .map((id) => header.querySelector<HTMLElement>(`[data-testid="${id}"]`))
          .filter((el): el is HTMLElement => !!el && el.offsetWidth > 0)
      : [header.firstElementChild as HTMLElement];
    const leftEdge = Math.max(...left.map((el) => el.getBoundingClientRect().right));
    const box = (r: DOMRect): { left: number; right: number } => ({ left: r.left, right: r.right });
    return { nav: box(clamp), search: box(search), leftEdge };
  }, shell) as Promise<{ nav: Box; search: Box; leftEdge: number }>;
}

async function sweep(page: Page, shell: 'app' | 'admin', path: string) {
  const failures: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(path);
    await expect(page.getByTestId(`${shell}-header`).locator('nav')).toBeVisible();
    // Let the HeaderStart ResizeObserver settle on the real pill width.
    await page.waitForTimeout(150);
    const m = await measure(page, shell);
    if (m.nav.right > m.search.left + 0.5) {
      failures.push(`${width}: pill right ${m.nav.right.toFixed(1)} > search left ${m.search.left.toFixed(1)}`);
    }
    if (m.nav.left < m.leftEdge - 0.5) {
      failures.push(`${width}: pill left ${m.nav.left.toFixed(1)} < left zone right ${m.leftEdge.toFixed(1)}`);
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);
}

test('app shell, member: the pill clears the search box and the wordmark at every width', async ({ page }) => {
  test.setTimeout(90_000);
  await signUpFresh(page);
  await sweep(page, 'app', '/library');
});

test('app shell, super-admin: the pill (with Admin) clears the search box and the wordmark at every width', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsSuperAdmin(page);
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(1);
  await sweep(page, 'app', '/library');
});

test('admin shell: the pill clears the search box and the wordmark at every width', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsSuperAdmin(page);
  await sweep(page, 'admin', '/admin');
});
