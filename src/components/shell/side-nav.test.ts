import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SideNav } from './side-nav';

const html = renderToStaticMarkup(createElement(SideNav, {
  label: 'Settings sections', testId: 'settings-nav',
  groups: [{ label: 'Your account', testId: 'g-1', items: [
    { href: '#prefs', label: 'Preferences', focusId: 'prefs-heading' },
    { href: '#account', label: 'Sign-in & password' },
    { href: '/help', label: 'Help' },
    { href: '#danger', label: 'Delete account', tone: 'danger' },
  ] }],
}));

describe('SideNav (C5 spec §1.2)', () => {
  it('is a labelled nav with its group label', () => {
    expect(html).toContain('<nav aria-label="Settings sections" data-testid="settings-nav"');
    expect(html).toContain('data-testid="g-1"');
    expect(html).toContain('>Your account</span>');
  });
  it('marks the first in-page item current on the server (no hash, no scroll yet)', () => {
    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    expect(html).toMatch(/<a href="#prefs" aria-current="true"/);
  });
  it('a route item is a link and never current; danger is red in both values', () => {
    expect(html).toMatch(/<a [^>]*href="\/help"/);
    expect(html).not.toMatch(/href="\/help"[^>]*aria-current/);
    expect(html).toMatch(/href="#danger"[^>]*color:var\(--danger-fg\)/);
  });
  it('names wrap rather than truncate', () => {
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).not.toContain('truncate');
  });
});
