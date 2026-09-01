import { test, expect, type Page } from '@playwright/test';

/**
 * Contrast, measured off the rendered page rather than reviewed by eye.
 *
 * Both defects this file guards shipped through review, a green build and a
 * green suite, because neither is visible in the source of the file that
 * causes it:
 *
 *  - /sign-in and /sign-up were the only pages with no shell and no glass
 *    surface, so shadcn's `--foreground` (#252525, which assumes a white
 *    page) landed on `--grad-top` (#1b2534). Measured 1.01:1 -- the heading
 *    was the same colour as the thing behind it.
 *  - sonner resolved `theme="system"` from prefers-color-scheme (no
 *    ThemeProvider is mounted, so useTheme fell back), which applies a
 *    HARD-CODED #e8e8e8 description colour, while the toast background
 *    stayed white because that half IS tokenised. 1.23:1, title unaffected.
 *
 * The lesson worth keeping: a colour can arrive from a stylesheet no file in
 * this repo names. Assert the composited pixels.
 */
import { signUpFresh } from './helpers';
import { cleanupSeeded } from './device-helpers';
import { signInAsSuperAdmin } from './admin-helpers';

test.afterAll(cleanupSeeded);

/**
 * The element's own rendered colour, over the first thing actually painted
 * behind it. Measured from the live page rather than from the stylesheet,
 * because the whole bug class here is a colour arriving from somewhere the
 * source does not obviously name.
 */
async function probe(page: Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    // Rasterise, do not string-match. This app declares colours in oklch(),
    // and a browser may hand any of them back from getComputedStyle in
    // oklch() OR lab() -- sonner's white toast computes to `lab(100 0 0)`.
    // No rgb() regex reads those, and canvas fillStyle echoes them back
    // verbatim rather than converting. Painting one pixel and reading it is
    // the only conversion that works for every colour space, and it is also
    // what the screen actually shows.
    const ctx = document.createElement('canvas').getContext('2d')!;
    const SENTINEL = '#010203';
    const parse = (v: string) => {
      if (!v || v === 'transparent') return null;
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = v;
      // An unparseable value leaves fillStyle untouched; without this check
      // it would silently read as a real, opaque #010203.
      if (ctx.fillStyle === SENTINEL && v.toLowerCase() !== SENTINEL) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    let bg: number[] | null = null;
    let node: Element | null = el;
    while (node) {
      const p = parse(getComputedStyle(node).backgroundColor);
      if (p && (p[3] ?? 1) > 0.5) { bg = p; break; }
      node = node.parentElement;
    }
    const fg = parse(getComputedStyle(el).color);
    if (!fg || !bg) return null;
    return { fg, bg, text: el.textContent ?? '' };
  }, sel);
}

function ratio(fg: number[], bg: number[]) {
  const lum = (c: number[]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const path of ['/sign-in', '/sign-up']) {
  test(`${path} text is legible on the gradient`, async ({ page }) => {
    await page.goto(path);
    for (const sel of ['h1', 'label[for="email"]', 'label[for="password"]', 'button[type="submit"]']) {
      const p = await probe(page, sel);
      expect(p, `${sel} not found or transparent`).toBeTruthy();
      const r = ratio(p!.fg, p!.bg);
      console.log(`${path.padEnd(9)} ${sel.padEnd(24)} ${r.toFixed(2)}:1  "${p!.text.slice(0, 24)}"`);
      expect(r, `${sel} contrast`).toBeGreaterThan(4.5);
    }
    await page.screenshot({ path: `test-results/zz${path.replace('/', '-')}.png` });
  });
}

test('a toast description is legible', async ({ page }) => {
  await signUpFresh(page);
  await signInAsSuperAdmin(page);
  await page.goto('/admin/invites');
  // Force the fetch to fail: that is the branch raising a toast WITH a
  // description. The success path renders the code inline instead.
  await page.route('**/api/admin/invites', (r) => r.abort());
  await page.getByRole('button', { name: /issue invite/i }).click();

  await expect(page.locator('[data-description]').first()).toBeVisible({ timeout: 10_000 });
  // Let the entrance animation finish: a toast measured mid-fade reports the
  // colour it is heading towards, but photographs as something else.
  await page.waitForTimeout(600);
  const p = await probe(page, '[data-description]');
  expect(p, 'toast description not found').toBeTruthy();
  const r = ratio(p!.fg, p!.bg);
  console.log(`toast     [data-description]     ${r.toFixed(2)}:1  "${p!.text.slice(0, 40)}"`);
  await page.screenshot({ path: 'test-results/zz-toast.png' });
  expect(r).toBeGreaterThan(4.5);
});
