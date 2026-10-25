import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ratio } from '@/lib/contrast.test-util';
import { MENU_ITEM, MENU_ITEM_HIGHLIGHT, MENU_ITEM_RING_TOKEN } from './menu-item-look';

// Final review I2: the highlighted menu item needs a cue of at least 3:1 against the popup (WCAG 1.4.11 / 2.4.7).
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
function tok(name: string): string {
  const all = [...css.matchAll(new RegExp(`(${name}):\\s*(#[0-9a-fA-F]{6})\\b`, 'g'))];
  if (all.length === 0) throw new Error(`${name} is not set as a #rrggbb hex in globals.css`);
  return all[all.length - 1][2].toUpperCase();
}

describe('menu item highlight', () => {
  it('has a ring in a token that is 3:1 against the popup and against the highlighted fill', () => {
    const ring = tok(MENU_ITEM_RING_TOKEN);
    expect(ratio(ring, tok('--surface'))).toBeGreaterThanOrEqual(3);
    expect(ratio(ring, tok('--track'))).toBeGreaterThanOrEqual(3);
  });

  it('applies the fill and the ring on highlight and on focus, for destructive items too', () => {
    for (const v of ['data-highlighted', 'focus', 'data-[variant=destructive]:data-highlighted', 'data-[variant=destructive]:focus']) {
      const base = v.includes(':') ? v : `${v}:`;
      const p = v.includes(':') ? `${v}:` : base;
      expect(MENU_ITEM_HIGHLIGHT).toContain(`${p}bg-[var(--track)]`);
      expect(MENU_ITEM_HIGHLIGHT).toContain(`${p}shadow-[inset_0_0_0_2px_var(${MENU_ITEM_RING_TOKEN})]`);
    }
  });
});

describe('MENU_ITEM (C4 Task 1: moved from title-menu.tsx, unchanged)', () => {
  it('is the 44 px / 36 px item with the shared highlight', () => {
    expect(MENU_ITEM.startsWith('h-11 gap-2.5 rounded-lg px-2.5 py-0 text-[13px] sm:h-9 ')).toBe(true);
    expect(MENU_ITEM).toContain('data-highlighted:bg-[var(--track)]');
    expect(MENU_ITEM.endsWith('[&_svg:not([class*=size-])]:size-4')).toBe(true);
  });
});
