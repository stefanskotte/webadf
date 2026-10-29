import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePrefs } from '@/lib/user-prefs-schema';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const { FilesSettings } = await import('./files-settings');

const html = (raw: unknown) => renderToStaticMarkup(createElement(FilesSettings, { prefs: parsePrefs(raw) }));
// The opening tag carrying a test id (attribute order is the component's business).
const tag = (h: string, id: string) => h.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? '';

describe('FilesSettings', () => {
  it('is the #files card with its six rows in order', () => {
    const h = html({});
    expect(h).toContain('id="files"');
    expect(h).toContain('data-testid="files-settings"');
    const order = ['pref-files-left', 'pref-files-right', 'pref-files-show-info', 'pref-files-comments', 'pref-files-confirm-delete', 'pref-files-on-clash']
      .map((t) => h.indexOf(`data-testid="${t}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('shows the stored values: defaults, then a changed row', () => {
    const d = html({});
    expect(tag(d, 'pref-files-left')).toContain('data-value="STASH"');
    expect(tag(d, 'pref-files-show-info')).toContain('aria-checked="true"');
    expect(tag(d, 'pref-files-on-clash')).toContain('data-value="ask"');
    const c = html({ browse: { hideInfo: true }, files: { confirmDelete: false, onClash: 'skip', panes: { right: 'NET' } } });
    expect(tag(c, 'pref-files-show-info')).toContain('aria-checked="false"');
    expect(tag(c, 'pref-files-confirm-delete')).toContain('aria-checked="false"');
    expect(tag(c, 'pref-files-on-clash')).toContain('data-value="skip"');
    expect(tag(c, 'pref-files-right')).toContain('data-value="NET"');
  });
  it('says STASH: and NET: always ask', () => {
    expect(html({})).toContain('STASH: and NET: always ask.');
  });
});
