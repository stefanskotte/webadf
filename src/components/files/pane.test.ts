import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FsEntry, Listing } from '@/lib/files/types';
import { EMPTY_SELECTION, type Selection } from '@/lib/files/selection';
import { Pane, type PaneProps } from './pane';

const entry = (name: string, kind: FsEntry['kind'], o: Partial<FsEntry> = {}): FsEntry => ({
  name, kind, path: `LIBRARY:/g/d/${name}`, size: kind === 'file' ? 1000 : null, date: '2019-08-14T00:00:00.000Z',
  protection: '----rwed', comment: null, marks: [], ...o,
});

const diskListing: Listing = {
  path: 'LIBRARY:/g/d',
  crumbs: [{ label: 'LIBRARY:', path: 'LIBRARY:' }, { label: 'SysInfo', path: 'LIBRARY:/g' }, { label: 'Disk 1', path: 'LIBRARY:/g/d' }],
  // Files first on purpose: the pane sorts, folders first.
  entries: [entry('List', 'file', { size: 5120 }), entry('Assign', 'file', { size: 3072, protection: 'hsparwed' }), entry('Tools', 'dir')],
  writable: true, readOnlyReason: null, disk: null, meta: '1 folder · 2 files',
};

const rootListing: Listing = {
  path: 'LIBRARY:', crumbs: [{ label: 'LIBRARY:', path: 'LIBRARY:' }],
  entries: [entry('SysInfo', 'title', { path: 'LIBRARY:/g', protection: null, date: null })],
  writable: false, readOnlyReason: null, disk: null, meta: '1 titles',
};

const noop = () => {};
function render(o: Partial<PaneProps> = {}): string {
  const props: PaneProps = {
    side: 'left', active: true, listing: diskListing, loading: false, error: null,
    sort: { key: 'name', dir: 'asc' }, selection: EMPTY_SELECTION, showComment: false,
    onActivate: noop, onNavigate: noop, onSort: noop, onRowClick: noop, onRowOpen: noop,
    onDragStartRows: noop, onDropRows: noop, ...o,
  };
  return renderToStaticMarkup(createElement(Pane, props));
}

/** Each row's opening tag, in document order. */
const rows = (html: string) => [...html.matchAll(/<tr\b[^>]*data-testid="pane-row"[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
/** The opening tag of the element carrying `testid`. */
const tagOf = (html: string, testid: string) => html.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${testid}"[^>]*>`))?.[0];

describe('Pane (Files increment 1, Task 7)', () => {
  it('is a labelled section carrying its side and whether it is active', () => {
    const html = render();
    const root = tagOf(html, 'pane-left')!;
    expect(root).toMatch(/^<section\b/);
    expect(attr(root, 'data-active')).toBe('true');
    expect(attr(root, 'aria-label')).toBe('Left pane');
    const right = tagOf(render({ side: 'right', active: false }), 'pane-right')!;
    expect(attr(right, 'data-active')).toBe('false');
    expect(attr(right, 'aria-label')).toBe('Right pane');
  });

  it('lists folders first, then files by the sort', () => {
    const r = rows(render());
    expect(r.map((t) => attr(t, 'data-name'))).toEqual(['Tools', 'Assign', 'List']);
    expect(r.map((t) => attr(t, 'data-kind'))).toEqual(['dir', 'file', 'file']);
    const desc = rows(render({ sort: { key: 'name', dir: 'desc' } }));
    expect(desc.map((t) => attr(t, 'data-name'))).toEqual(['Tools', 'List', 'Assign']);
  });

  it('marks the sorted column with aria-sort and a hidden glyph; the others are none', () => {
    const html = render();
    expect(attr(tagOf(html, 'pane-left-sort-name')!, 'aria-sort')).toBe('ascending');
    for (const k of ['size', 'protection', 'date']) expect(attr(tagOf(html, `pane-left-sort-${k}`)!, 'aria-sort')).toBe('none');
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>▲<\/span>/);
    expect(html).not.toContain('▼');
    const desc = render({ sort: { key: 'date', dir: 'desc' } });
    expect(attr(tagOf(desc, 'pane-left-sort-date')!, 'aria-sort')).toBe('descending');
    expect(desc).toMatch(/<span aria-hidden="true"[^>]*>▼<\/span>/);
  });

  it('a Comment column only with showComment', () => {
    expect(render()).not.toContain('>Comment<');
    expect(render({ showComment: true })).toContain('>Comment<');
  });

  it('picked rows (indexes into the SORTED rows) are aria-selected, and the foot counts them', () => {
    const selection: Selection = { anchor: 1, cursor: 2, picked: new Set([1, 2]) };
    const html = render({ selection });
    expect(rows(html).map((t) => attr(t, 'aria-selected'))).toEqual(['false', 'true', 'true']);
    expect(html).toMatch(/data-testid="pane-left-foot"[^>]*>(<[^>]*>)*2 of 3 selected · 8 KB/);
    expect(render()).toMatch(/data-testid="pane-left-foot"[^>]*>(<[^>]*>)*1 folder · 2 files/);
  });

  it('draws the eight protection cells the Browse table uses', () => {
    const html = render();
    expect(html).toContain('title="Hidden"');
    expect(html).toContain('title="Deletable"');
    // Assign is hsparwed: every letter on.
    expect(html).toMatch(/title="Hidden"[^>]*>h</);
  });

  it('a read-only line in words when the listing cannot be written', () => {
    expect(render()).not.toContain('pane-left-readonly');
    const ro = render({ listing: { ...diskListing, writable: false, readOnlyReason: 'hfe_read_only' } });
    expect(ro).toMatch(/data-testid="pane-left-readonly"[^>]*>[^<]*HFE disks are read-only\./);
    const held = render({ listing: { ...diskListing, writable: false, readOnlyReason: 'mounted on "A500 bench"' } });
    expect(held).toContain('This disk is in a drive (mounted on &quot;A500 bench&quot;)');
  });

  it('crumbs are buttons in a Path nav; ↑ is disabled at LIBRARY: and enabled below it', () => {
    const html = render();
    expect(html).toContain('aria-label="Path"');
    expect(tagOf(html, 'pane-left-crumb-0')).toMatch(/^<button\b/);
    expect(tagOf(html, 'pane-left-crumb-2')).toMatch(/^<button\b/);
    expect(tagOf(html, 'pane-left-up')).not.toMatch(/\bdisabled=""/);
    const root = render({ listing: rootListing });
    expect(tagOf(root, 'pane-left-up')).toMatch(/\bdisabled=""/);
    expect(tagOf(root, 'pane-left-crumb-1')).toBeUndefined();
  });

  it('only the LIBRARY: device button, pressed', () => {
    const html = render();
    const devs = [...html.matchAll(/data-testid="pane-left-dev-([^"]+)"/g)].map((m) => m[1]);
    expect(devs).toEqual(['LIBRARY']);
    expect(attr(tagOf(html, 'pane-left-dev-LIBRARY')!, 'aria-pressed')).toBe('true');
  });

  it('a meta line, a loading line and an error line', () => {
    expect(tagOf(render(), 'pane-left-meta')).toBeDefined();
    expect(render({ listing: null, loading: true })).toContain('data-testid="pane-left-loading"');
    expect(render({ listing: null, error: 'That is no longer there.' })).toMatch(/role="alert"[^>]*>That is no longer there\./);
  });
});
