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
import { randomUUID } from 'node:crypto';
import { signUpFresh, runTag } from './helpers';
import { cleanupSeeded, seedDisk } from './device-helpers';
import { signInAsSuperAdmin } from './admin-helpers';

test.afterAll(cleanupSeeded);

/**
 * The element's own rendered colour, over what is actually composited
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
    // Walk from the element outward (toward the root), collecting every
    // background along the way -- opaque or translucent -- stopping once
    // one is opaque enough (alpha > 0.5) to serve as a backstop with
    // nothing usable behind it.
    //
    // A translucent layer (e.g. the search panel's highlighted-row overlay,
    // rgb(30 45 60 / 0.08)) is real paint, not noise: skipping it entirely,
    // as an earlier version of this function did, silently measures the
    // PLAIN panel's colour instead of the highlighted one -- landing on a
    // higher, wrong ratio for exactly the row a bug is most likely to ship
    // on, since highlight defaults to index 0.
    const layers: number[][] = [];
    let node: Element | null = el;
    while (node) {
      const p = parse(getComputedStyle(node).backgroundColor);
      if (p) {
        layers.push(p);
        if (p[3] > 0.5) break;
      }
      node = node.parentElement;
    }
    if (layers.length === 0) return null;
    // layers[0] is nearest to the element (painted last, i.e. on top);
    // layers[last] is the opaque backstop (painted first, i.e. on the
    // bottom). Composite back-to-front with the standard "over" operator,
    // treating the backstop itself as fully opaque.
    const backstop = layers[layers.length - 1];
    let bg: number[] = [backstop[0], backstop[1], backstop[2], 1];
    for (let i = layers.length - 2; i >= 0; i--) {
      const top = layers[i];
      const a = top[3] + bg[3] * (1 - top[3]);
      bg = [
        (top[0] * top[3] + bg[0] * bg[3] * (1 - top[3])) / a,
        (top[1] * top[3] + bg[1] * bg[3] * (1 - top[3])) / a,
        (top[2] * top[3] + bg[2] * bg[3] * (1 - top[3])) / a,
        a,
      ];
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

test('the search panel metadata line is legible while its row is highlighted', async ({ page }) => {
  // The panel's own comment (search-box.tsx) works out the math for this
  // exact case: the panel is painted opaque (#f1f4f5) precisely because the
  // translucent version measured under AA on the page gradient's dark band,
  // and the highlighted row then composites a further overlay
  // (rgb(30 45 60 / 0.08)) on top of that, landing on ~#e0e4e6. --muted
  // (not --muted-2) is what the metadata line uses there, landing at
  // ~5.6:1. probe() now actually composites that overlay rather than
  // skipping it as a low-alpha layer, so this measures the real
  // highlighted-row pixels rather than the plain panel underneath them.
  // Highlight defaults to index 0, so the TOP row -- the one this test
  // reads -- is highlighted by default, not an edge case reached only by
  // hovering.
  const run = runTag();
  const u = await signUpFresh(page);
  await seedDisk(u.orgId, {
    title: `Contrast Row ${run}`, diskNo: 1,
    sha256: randomUUID().replace(/-/g, '').padEnd(64, 'c'),
  });

  await page.getByTestId('search-input').fill('Contrast Row');
  await expect(page.getByTestId('search-result').first()).toBeVisible();

  // The metadata line is the second (last) span in the top result's button
  // -- querySelector returns the first DOM match, which is that top,
  // highlighted-by-default row.
  const p = await probe(page, '[data-testid="search-result"] span:last-child');
  expect(p, 'search result metadata line not found').toBeTruthy();
  const r = ratio(p!.fg, p!.bg);
  console.log(`search    metadata line                  ${r.toFixed(2)}:1  "${p!.text.slice(0, 40)}"`);
  expect(r).toBeGreaterThan(4.5);
});
