import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nav = vi.hoisted(() => ({ path: '/settings' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));

const { SettingsSections, settingsHelpTopic, legacySettingsHash } = await import('./settings-sections');

const current = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].filter((m) => m[0].includes('aria-current="page"')).map((m) => m[1]);

describe('SettingsSections (Settings reorganisation 2026-10-28)', () => {
  it('is the labelled .seg nav of Account, Library and Server, in order', () => {
    const html = renderToStaticMarkup(createElement(SettingsSections));
    expect(html).toContain('aria-label="Settings sections"');
    expect(html).toContain('data-testid="settings-sections"');
    expect([...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]))
      .toEqual([['/settings', 'Account'], ['/settings/library', 'Library'], ['/settings/server', 'Server']]);
  });
  it('marks exactly the current tab (exact match: /settings is a prefix of the others)', () => {
    for (const [path, label] of [['/settings', 'Account'], ['/settings/library', 'Library'],
      ['/settings/server', 'Server']] as const) {
      nav.path = path;
      expect(current(renderToStaticMarkup(createElement(SettingsSections)))).toEqual([label]);
    }
  });
});

describe('settingsHelpTopic', () => {
  it("is each tab's own help topic, none on Server", () => {
    expect(settingsHelpTopic('/settings')).toBe('preferences');
    expect(settingsHelpTopic('/settings/library')).toBe('sharing');
    expect(settingsHelpTopic('/settings/server')).toBeUndefined();   // the About card has its own
  });
});

describe('legacySettingsHash', () => {
  it('sends the old one-page anchors to their new tab, and leaves the rest alone', () => {
    expect(legacySettingsHash('#sharing')).toBe('/settings/library');
    expect(legacySettingsHash('#about')).toBe('/settings/server');
    expect(legacySettingsHash('#prefs')).toBeNull();
    expect(legacySettingsHash('')).toBeNull();
  });
});
