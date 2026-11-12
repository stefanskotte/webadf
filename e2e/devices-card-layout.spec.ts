import { test, expect, type Locator, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, cleanupSeeded } from './device-helpers';

// The card's figures never break a value mid-token (C9 shots, 2026-10-26: at 1440 the MAC wrapped to "…AC:C / A"
// and the firmware to "1.21.1+ga5424 / b4"). Since 2026-11-12 the MAC is in Board settings and the firmware line
// drops its build suffix, so the whole line fits one line.
test.afterAll(cleanupSeeded);

/** The distinct line tops a substring of `el`'s text is drawn on. */
async function linesOf(el: Locator, needle: string): Promise<number> {
  return el.evaluate((node, n) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const i = (t.textContent ?? '').indexOf(n);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i); r.setEnd(t, i + n.length);
      return new Set([...r.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size;
    }
    return -1;
  }, needle);
}

async function seedBoard(page: Page, request: Parameters<typeof pairDevice>[1]) {
  await signUpFresh(page);
  const { deviceId } = await pairDevice(page, request, 'A500');
  await getDb().update(devices).set({ firmwareVersion: '1.21.1+ga5424b4', macAddress: '02:D6:E7:07:AC:CA', lastSeenAt: new Date() })
    .where(eq(devices.id, deviceId));
  return deviceId;
}

for (const width of [1440, 1280, 1024, 390]) {
  test(`at ${width} px the firmware line is words on one line, the MAC is off the card`, async ({ page, request }) => {
    const id = await seedBoard(page, request);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/devices');
    const fw = page.getByTestId(`device-firmware-${id}`);
    await expect(fw).toBeVisible();
    // Firmware in words (2026-11-12): no build suffix in the text, the full version in the title, and the whole line
    // (version and state) on one line at 390 and 1440 -- it spans both columns while online.
    await expect(fw).not.toContainText('+ga5424b4');
    await expect(fw).toHaveAttribute('title', 'Firmware 1.21.1+ga5424b4');
    const text = (await fw.textContent())!;
    expect(text).toMatch(/^1\.21\.1 · /);
    // Never broken mid-word: the version and every word of the state each sit on one line. (At 1024 the info column
    // beside the drive tile and the aside is ~170 px, so the state may take a second line, at a space.)
    for (const word of text.split(/\s+/).filter((w) => w.length > 1)) expect(await linesOf(fw, word), word).toBe(1);
    if (width === 390 || width === 1440) expect(await linesOf(fw, text), 'the firmware line').toBe(1);
    // The MAC moved to Board settings.
    await expect(page.getByTestId(`device-facts-${id}`)).not.toContainText('02:D6:E7:07:AC:CA');
    // And the page never scrolls sideways for it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
