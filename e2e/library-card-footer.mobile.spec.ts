import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '@/db';
import { blobs } from '@/db/schema/catalog';
import { tosecEntries } from '@/db/schema/tosec';
import { signUpFresh, runTag } from './helpers';
import { seedDisk, cleanupSeeded } from './device-helpers';

// A 2-column phone card's footer shows its kind pill and disk count whole (C9 shots, 2026-10-26: "De…", "1 di…").
test.afterAll(cleanupSeeded);

test('at 390 a card footer never truncates the kind pill or the disk count; the ⋯ stays inside the card', async ({ page }) => {
  const { orgId } = await signUpFresh(page);
  // A kind comes from the blob's TOSEC set: point this test's own blob at a real Amiga demo entry.
  const [entry] = await getDb().select({ id: tosecEntries.id }).from(tosecEntries)
    .where(and(ilike(tosecEntries.setName, '%Commodore Amiga%'), ilike(tosecEntries.setName, '%Demos%'))).limit(1);
  test.skip(!entry, 'no Amiga demo set imported on this server');
  const sha = createHash('sha256').update(`footer-${runTag()}`).digest('hex');
  const { gameId } = await seedDisk(orgId, { title: `Ray of Hope 2 ${runTag()}`, diskNo: 1, sha256: sha });
  await getDb().update(blobs).set({ tosecEntryId: entry.id }).where(eq(blobs.sha256, sha));

  await page.goto('/library');
  const card = page.locator(`[data-testid="game-card"][data-game-id="${gameId}"]`);
  await expect(card.getByTestId('grid-kind')).toHaveText('Demo');
  for (const id of ['grid-kind', 'grid-disks']) {
    const el = card.getByTestId(id);
    expect(await el.evaluate((e) => e.scrollWidth <= e.clientWidth), `${id} is not cut off`).toBe(true);
  }
  await expect(card.getByTestId('grid-disks')).toHaveText('1 disk');
  const c = (await card.boundingBox())!;
  const menu = (await card.getByRole('button', { name: /more|actions|menu/i }).first().boundingBox())!;
  expect(menu.x + menu.width).toBeLessThanOrEqual(c.x + c.width);
  // When it wraps to a second line it keeps to the card's right edge, as on one line.
  expect(c.x + c.width - (menu.x + menu.width)).toBeLessThan(24);
});
