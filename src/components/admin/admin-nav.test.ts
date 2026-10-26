import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nav = vi.hoisted(() => ({ path: '/admin' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));

const { AdminSections } = await import('./admin-nav');
const { AdminPageHead, ADMIN_BODY } = await import('./admin-page-head');

/** The text of every link marked current, whatever order React writes the attributes in. */
const current = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].filter((m) => m[0].includes('aria-current="page"')).map((m) => m[1]);

describe('AdminSections (C6 spec §1.2, Ruling 2)', () => {
  it('is the labelled .seg nav of the five sections, in order, in a scroll clamp', () => {
    const html = renderToStaticMarkup(createElement(AdminSections));
    expect(html).toContain('aria-label="Admin sections"');
    expect(html).toContain('data-testid="admin-sections"');
    expect(html).toMatch(/class="seg w-max max-sm:w-full"/);
    expect(html).toMatch(/^<div class="max-w-full overflow-x-auto"/);
    expect([...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]))
      .toEqual(['Overview', 'Users', 'Invites', 'Scan', 'Firmware']);
    expect(html.match(/class="seg-item whitespace-nowrap"/g)?.length).toBe(5);
  });
  it('marks exactly the current page (exact match: /admin is a prefix of the others)', () => {
    for (const [path, label] of [['/admin', 'Overview'], ['/admin/users', 'Users'], ['/admin/invites', 'Invites'],
      ['/admin/scan', 'Scan'], ['/admin/firmware', 'Firmware']] as const) {
      nav.path = path;
      expect(current(renderToStaticMarkup(createElement(AdminSections)))).toEqual([label]);
    }
    nav.path = '/admin/elsewhere';
    expect(current(renderToStaticMarkup(createElement(AdminSections)))).toEqual([]);
  });
  it('has no count badge (Ruling 2)', () => {
    nav.path = '/admin';
    expect(renderToStaticMarkup(createElement(AdminSections))).not.toMatch(/live</);
  });
});

describe('AdminPageHead (C6 spec §1.3, Ruling 6)', () => {
  it('is the lg PageHeader with the server eyebrow, then the tabs in the page gutter', () => {
    nav.path = '/admin/scan';
    const html = renderToStaticMarkup(createElement(AdminPageHead, {
      title: 'Scan', subtitle: 'A sentence.', subtitleFont: 'sans', actions: createElement('button', null, 'Run now'),
    }));
    expect(html).toContain('>Admin · this server</span>');
    expect(html).toContain('sm:text-[44px]');
    expect(html).toContain('>Scan</h1>');
    expect(html).toContain('>A sentence.</span>');
    expect(html).toContain('<button>Run now</button>');
    expect(html.indexOf('</h1>')).toBeLessThan(html.indexOf('data-testid="admin-sections"'));
    expect(html).toContain('class="flex flex-col items-start px-4 pb-6 sm:px-7"');
    expect(ADMIN_BODY).toBe('flex flex-col gap-6 px-4 pb-10 sm:px-7');
  });
});
