import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nav = vi.hoisted(() => ({ path: '/library' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock('@/lib/auth-client', () => ({ signOut: async () => ({}) }));

const { TopNav } = await import('./top-nav');
const render = (path: string, showAdmin = false) => {
  nav.path = path;
  return renderToStaticMarkup(createElement(TopNav, { showAdmin }));
};
/** Each link's opening tag and its text (a tab holds an empty bar span before the word). */
const links = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>(?:<span[^>]*><\/span>)?([^<]*)<\/a>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
const more = (html: string) => html.match(/<button[^>]*data-testid="nav-more"[^>]*>/)?.[0] ?? '';

describe('TopNav (C7 spec §2.3, Rulings 4, 5, 8)', () => {
  it('is one Main nav: the .seg pill from lg, the tab bar below it', () => {
    const html = render('/library');
    expect(html.match(/<nav /g)?.length).toBe(1);
    expect(html).toContain('<nav aria-label="Main" class="seg nav-tabs lg:w-max">');
  });
  it('keeps Library, Devices, Upload, Help (+ Admin); Help and Admin are in More below lg', () => {
    const member = links(render('/library'));
    expect(member.map((l) => l.text)).toEqual(['Library', 'Devices', 'Upload', 'Help']);
    expect(member[3].attrs).toContain('max-lg:hidden');
    for (const l of member.slice(0, 3)) expect(l.attrs).not.toContain('max-lg:hidden');
    const admin = links(render('/library', true));
    expect(admin.map((l) => l.text)).toEqual(['Library', 'Devices', 'Upload', 'Help', 'Admin']);
    expect(admin[4].attrs).toContain('max-lg:hidden');
  });
  it('More is a menu button shown below lg only, current on Settings, Help and Admin', () => {
    expect(more(render('/library'))).toContain('lg:hidden');
    expect(more(render('/library'))).toContain('aria-haspopup="menu"');
    expect(more(render('/library'))).not.toContain('aria-current');
    for (const p of ['/settings', '/help', '/admin/users']) expect(more(render(p, true)), p).toContain('aria-current="page"');
    expect(render('/library')).toMatch(/data-testid="nav-more"[^>]*>(?:<span[^>]*><\/span>)?More<\/button>/);
  });
  it('every tab carries its bar: amber on the current one, transparent on the others', () => {
    const html = render('/devices');
    expect(html.match(/data-tab-bar=""/g)?.length).toBe(5);   // four links + More
    expect(html).toMatch(/aria-current="page"[^>]*><span aria-hidden="true" data-tab-bar="" class="[^"]*" style="background:var\(--accent-amber\)"><\/span>Devices/);
    expect(html.match(/background:var\(--accent-amber\)/g)?.length).toBe(1);
    expect(html.match(/background:transparent/g)?.length).toBe(4);
  });
  it('the menu items are not in the page while the menu is closed', () => {
    expect(render('/library', true)).not.toContain('more-help');
  });
});
