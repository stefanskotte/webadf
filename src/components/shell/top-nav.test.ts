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
  it('is Library, Remote, Devices, Upload, Help (+ Admin); Remote, Help and Admin are in More below lg', () => {
    const member = links(render('/library'));
    expect(member.map((l) => l.text)).toEqual(['Library', 'Remote', 'Devices', 'Upload', 'Help']);
    for (const i of [1, 4]) expect(member[i].attrs).toContain('max-lg:hidden');
    for (const i of [0, 2, 3]) expect(member[i].attrs).not.toContain('max-lg:hidden');
    expect(member[1].attrs).toContain('href="/remote"');
    const admin = links(render('/library', true));
    expect(admin.map((l) => l.text)).toEqual(['Library', 'Remote', 'Devices', 'Upload', 'Help', 'Admin']);
    expect(admin[5].attrs).toContain('max-lg:hidden');
  });
  it('Remote is current on /remote and the pages under it; More is current there too below lg', () => {
    const html = render('/remote/lib1/titles/t1');
    expect(links(html).find((l) => l.text === 'Remote')!.attrs).toContain('aria-current="page"');
    expect(more(html)).toContain('aria-current="page"');
  });
  it('More is a menu button shown below lg only, current on Settings, Help, Admin and Remote', () => {
    expect(more(render('/library'))).toContain('lg:hidden');
    expect(more(render('/library'))).toContain('aria-haspopup="menu"');
    expect(more(render('/library'))).not.toContain('aria-current');
    for (const p of ['/settings', '/help', '/admin/users', '/remote']) expect(more(render(p, true)), p).toContain('aria-current="page"');
    expect(render('/library')).toMatch(/data-testid="nav-more"[^>]*>(?:<span[^>]*><\/span>)?More<\/button>/);
  });
  it('every tab carries its bar: amber on the current one, transparent on the others', () => {
    const html = render('/devices');
    expect(html.match(/data-tab-bar=""/g)?.length).toBe(6);   // five links + More
    expect(html).toMatch(/aria-current="page"[^>]*><span aria-hidden="true" data-tab-bar="" class="[^"]*" style="background:var\(--accent-amber\)"><\/span>Devices/);
    expect(html.match(/background:var\(--accent-amber\)/g)?.length).toBe(1);
    expect(html.match(/background:transparent/g)?.length).toBe(5);
  });
  it('the menu items are not in the page while the menu is closed', () => {
    expect(render('/library', true)).not.toContain('more-help');
  });
});
