import { test, expect, type Locator, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { signUpFresh } from './helpers';
import { pairDevice, cleanupSeeded } from './device-helpers';

// The card's figures never break a value mid-token (C9 shots, 2026-10-26: at 1440 the MAC wrapped to "…AC:C / A"
// and the firmware to "1.21.1+ga5424 / b4"). A MAC and a version are read and copied as one piece.
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
  test(`at ${width} px the MAC and the firmware version are each on one line`, async ({ page, request }) => {
    const id = await seedBoard(page, request);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/devices');
    const card = page.getByTestId(`device-firmware-${id}`).locator('xpath=ancestor::dl[1]');
    await expect(card).toBeVisible();
    expect(await linesOf(card, '02:D6:E7:07:AC:CA'), 'the MAC').toBe(1);
    expect(await linesOf(page.getByTestId(`device-firmware-${id}`), '1.21.1+ga5424b4'), 'the version').toBe(1);
    // And the page never scrolls sideways for it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
