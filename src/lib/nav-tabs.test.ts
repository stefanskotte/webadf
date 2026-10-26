import { describe, it, expect } from 'vitest';
import { isMoreCurrent, isMoreItemCurrent, moreItems } from './nav-tabs';

describe('isMoreCurrent (C7 spec §2.3)', () => {
  it('is current on Settings, Help and Admin and every page under them', () => {
    for (const p of ['/settings', '/help', '/admin', '/admin/users', '/admin/firmware']) expect(isMoreCurrent(p), p).toBe(true);
  });
  it('is not current on the three other tabs, a title, a disk, or a lookalike path', () => {
    for (const p of ['/library', '/devices', '/ingest', '/games/g1', '/disks/d1/files', '/helpers', '/administrator']) {
      expect(isMoreCurrent(p), p).toBe(false);
    }
  });
});

describe('isMoreItemCurrent', () => {
  it('marks the page the item names, and the pages under it', () => {
    expect(isMoreItemCurrent('/settings', '/settings')).toBe(true);
    expect(isMoreItemCurrent('/admin/users', '/admin')).toBe(true);
    expect(isMoreItemCurrent('/help', '/settings')).toBe(false);
  });
  it('never marks an item with a hash: the pathname cannot tell one (Plan ruling)', () => {
    expect(isMoreItemCurrent('/settings', '/settings#about')).toBe(false);
  });
});

describe('moreItems', () => {
  it("is Help, Settings, About this server for a member, in the spec's order", () => {
    expect(moreItems(false).map((i) => [i.id, i.href, i.label])).toEqual([
      ['more-help', '/help', 'Help'],
      ['more-settings', '/settings', 'Settings'],
      ['more-about', '/settings#about', 'About this server'],
    ]);
  });
  it('adds Admin last only when the server said so', () => {
    expect(moreItems(true).map((i) => i.id)).toEqual(['more-help', 'more-settings', 'more-about', 'more-admin']);
    expect(moreItems(true)[3].href).toBe('/admin');
  });
});
