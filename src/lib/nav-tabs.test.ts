import { describe, it, expect } from 'vitest';
import { isMoreCurrent, isMoreItemCurrent, moreItems } from './nav-tabs';

describe('isMoreCurrent (C7 spec §2.3)', () => {
  it('is current on Remote, Settings, Help and Admin and every page under them', () => {
    for (const p of ['/remote', '/remote/add', '/remote/l1/titles/t1', '/settings', '/help', '/admin', '/admin/users', '/admin/firmware']) expect(isMoreCurrent(p), p).toBe(true);
  });
  it('is not current on the three other tabs, a title, a disk, or a lookalike path', () => {
    for (const p of ['/library', '/devices', '/ingest', '/games/g1', '/disks/d1/files', '/helpers', '/administrator', '/remotes']) {
      expect(isMoreCurrent(p), p).toBe(false);
    }
  });
});

describe('isMoreItemCurrent', () => {
  it('marks the page the item names, and the pages under it', () => {
    expect(isMoreItemCurrent('/settings', '/settings')).toBe(true);
    expect(isMoreItemCurrent('/admin/users', '/admin')).toBe(true);
    expect(isMoreItemCurrent('/help', '/settings')).toBe(false);
    expect(isMoreItemCurrent('/remote/l1', '/remote')).toBe(true);
  });
  it('never marks an item with a hash: the pathname cannot tell one (Plan ruling)', () => {
    expect(isMoreItemCurrent('/settings', '/settings#x')).toBe(false);
  });
  it('marks only the most specific item: About this server on /settings/server, not Settings too (tabs 2026-10-28)', () => {
    const hrefs = ['/remote', '/help', '/settings', '/settings/server'];
    expect(isMoreItemCurrent('/settings/server', '/settings/server', hrefs)).toBe(true);
    expect(isMoreItemCurrent('/settings/server', '/settings', hrefs)).toBe(false);
    expect(isMoreItemCurrent('/settings/library', '/settings', hrefs)).toBe(true);
    expect(isMoreItemCurrent('/settings', '/settings', hrefs)).toBe(true);
  });
});

describe('moreItems', () => {
  it("is Remote, Help, Settings, About this server for a member, in the spec's order", () => {
    expect(moreItems(false).map((i) => [i.id, i.href, i.label])).toEqual([
      ['more-remote', '/remote', 'Remote'],
      ['more-help', '/help', 'Help'],
      ['more-settings', '/settings', 'Settings'],
      ['more-about', '/settings/server', 'About this server'],
    ]);
  });
  it('adds Admin last only when the server said so', () => {
    expect(moreItems(true).map((i) => i.id)).toEqual(['more-remote', 'more-help', 'more-settings', 'more-about', 'more-admin']);
    expect(moreItems(true)[4].href).toBe('/admin');
  });
});
