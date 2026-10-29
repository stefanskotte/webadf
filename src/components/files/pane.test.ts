import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FsEntry, Listing } from '@/lib/files/types';
import { EMPTY_SELECTION, type Selection } from '@/lib/files/selection';
import { Pane, subLine, type PaneProps } from './pane';

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

const stashListing: Listing = {
  path: 'STASH:', crumbs: [{ label: 'STASH:', path: 'STASH:' }],
  entries: [
    entry('SysInfo.lha', 'archive', { path: 'STASH:/SysInfo.lha', size: 55296 }), entry('t.zip', 'archive', { path: 'STASH:/t.zip', size: 300 }),
    entry('ReadMe', 'file', { path: 'STASH:/ReadMe' }), entry('Game.adf', 'file', { path: 'STASH:/Game.adf', size: 901120 }),
    entry('Old.adf', 'file', { path: 'STASH:/Old.adf', size: 901120, marks: ['in the library'] }),
  ],
  writable: true, readOnlyReason: null, disk: null, meta: '3 files · 1 MB',
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
    onActivate: noop, onNavigate: noop, onSort: noop, onSetSort: noop, onRowClick: noop, onRowOpen: noop,
    onDragStartRows: noop, onDropRows: noop, onAddToLibrary: noop,
    view: { filter: '', hideInfo: false }, onFilter: noop, onShowInfo: noop, help: 'files', ...o,
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

  it('draws the strip it is given above the error when the disk image could not be read (final review)', () => {
    const strip = createElement('div', { 'data-testid': 'the-strip' });
    const html = render({ listing: null, error: 'The disk image could not be read. Try again in a moment.', strip });
    expect(html).toContain('data-testid="the-strip"');
    expect(html.indexOf('the-strip')).toBeLessThan(html.indexOf('pane-left-error'));
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

  it('the STASH:, NET: and LIBRARY: device buttons, the one shown pressed (increment 2 R1, increment 3)', () => {
    const html = render();
    const devs = [...html.matchAll(/data-testid="pane-left-dev-([^"]+)"/g)].map((m) => m[1]);
    expect(devs).toEqual(['STASH', 'NET', 'LIBRARY']);
    expect(attr(tagOf(html, 'pane-left-dev-LIBRARY')!, 'aria-pressed')).toBe('true');
    expect(attr(tagOf(html, 'pane-left-dev-STASH')!, 'aria-pressed')).toBe('false');
    const stash = render({ listing: stashListing });
    expect(attr(tagOf(stash, 'pane-left-dev-STASH')!, 'aria-pressed')).toBe('true');
    expect(attr(tagOf(stash, 'pane-left-dev-LIBRARY')!, 'aria-pressed')).toBe('false');
  });

  it('an archive row: a file to look at (size, glyph, weight) with an Open button (increment 2 ruling 7)', () => {
    const html = render({ listing: stashListing });
    const arc = rows(html).find((t) => attr(t, 'data-name') === 'SysInfo.lha')!;
    expect(attr(arc, 'data-kind')).toBe('archive');
    expect(html).toMatch(/>LHA<\/span><span class="truncate "[^>]*>SysInfo\.lha</);
    expect(html).toMatch(/>ZIP<\/span><span class="truncate "[^>]*>t\.zip</);
    expect(tagOf(html, 'pane-open-SysInfo.lha')).toMatch(/^<button\b/);
    expect(tagOf(html, 'pane-open-ReadMe')).toBeUndefined();
    expect(subLine(entry('SysInfo.lha', 'archive', { size: 55296 }))).toBe('54 KB · 2019-08-14');
  });

  it('a disk image in STASH: offers Add to library on its row, unless it is in the library already (increment 2 R8)', () => {
    const html = render({ listing: stashListing });
    expect(tagOf(html, 'pane-addlib-Game.adf')).toMatch(/^<button\b/);
    expect(tagOf(html, 'pane-addlib-Old.adf')).toBeUndefined();
    expect(tagOf(html, 'pane-addlib-ReadMe')).toBeUndefined();
    // Not inside a disk: a disk's ADF files are files on it, not images to add.
    const onDisk = render({ listing: { ...diskListing, entries: [entry('Game.adf', 'file')] } });
    expect(tagOf(onDisk, 'pane-addlib-Game.adf')).toBeUndefined();
  });

  it('the foot of a writable STASH: folder with nothing picked invites a drop (increment 2)', () => {
    expect(render({ listing: stashListing })).toMatch(/data-testid="pane-left-foot"[^>]*>(<[^>]*>)*3 files · 1 MB · Drop files here/);
    expect(render()).not.toContain('Drop files here');
    const inArchive = render({ listing: { ...stashListing, path: 'STASH:/t.zip', writable: false, readOnlyReason: 'archive' } });
    expect(inArchive).not.toContain('Drop files here');
  });

  it('a meta line, a loading line and an error line', () => {
    expect(tagOf(render(), 'pane-left-meta')).toBeDefined();
    expect(render({ listing: null, loading: true })).toContain('data-testid="pane-left-loading"');
    expect(render({ listing: null, error: 'That is no longer there.' })).toMatch(/role="alert"[^>]*>That is no longer there\./);
  });

  it('an entry a version added wears "new in vN", as on the Browse page (Task 9b)', () => {
    const html = render({ listing: { ...diskListing, entries: [entry('List', 'file', { addedIn: 3 }), entry('Assign', 'file')] } });
    const marks = [...html.matchAll(/data-testid="pane-new-([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
    expect(marks).toEqual([['List', 'new in v3']]);
  });

  it('below lg: the size and date under the name, the other columns hidden (Task 10)', () => {
    expect(subLine(entry('List', 'file', { size: 5120 }))).toBe('5 KB · 2019-08-14');
    expect(subLine(entry('Tools', 'dir'))).toBe('2019-08-14');
    expect(subLine(entry('SysInfo', 'title', { date: null }))).toBe('');
    const html = render();
    const subs = [...html.matchAll(/data-testid="pane-row-sub"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(subs).toEqual(['2019-08-14', '3 KB · 2019-08-14', '5 KB · 2019-08-14']);
    expect(tagOf(html, 'pane-row-sub')).toContain('lg:hidden');
    for (const k of ['size', 'protection', 'date']) expect(tagOf(html, `pane-left-sort-${k}`), k).toContain('max-lg:hidden');
    expect(tagOf(html, 'pane-left-sort-name')).not.toContain('max-lg:hidden');
    // A title has neither: no empty second line.
    expect(render({ listing: rootListing })).not.toContain('pane-row-sub');
  });

  it('below lg the controls a finger presses are 44 px (Task 10)', () => {
    const html = render();
    for (const id of ['pane-left-dev-STASH', 'pane-left-dev-LIBRARY', 'pane-left-up', 'pane-left-crumb-0']) expect(tagOf(html, id), id).toContain('max-lg:min-h-11');
  });

  it('below lg one sort button says the order in force, even one no phone column shows (Task 10 fix)', () => {
    const btn = (sort: PaneProps['sort']) => render({ sort }).match(/data-testid="pane-left-sort-phone"[^>]*>(.*?)<\/button>/)![1].replace(/<[^>]+>/g, '');
    expect(btn({ key: 'name', dir: 'asc' })).toBe('Name▲');
    expect(btn({ key: 'date', dir: 'desc' })).toBe('Date▼');
    expect(btn({ key: 'size', dir: 'asc' })).toBe('Size▲');
    expect(tagOf(render(), 'pane-left-sort-phone')).toContain('lg:hidden');
  });

  it('NET: lists boards as BRD rows with their marks; NET:/<board> its queue, rows that do not drag (increment 3, Task 2)', () => {
    const boards: Listing = {
      path: 'NET:', crumbs: [{ label: 'NET:', path: 'NET:' }], writable: false, readOnlyReason: 'Open a board to send files to it', disk: null, meta: '1 board',
      entries: [entry('A500 bench', 'board', { path: 'NET:/b1', size: null, date: null, protection: null, marks: ['online', '2 waiting', 'key AB12'] })],
    };
    const html = render({ listing: boards });
    const r = rows(html);
    expect(r.map((t) => attr(t, 'data-kind'))).toEqual(['board']);
    expect(html).toMatch(/>BRD<\/span><span class="truncate font-semibold"[^>]*>A500 bench</);
    expect(html).toContain('>key AB12<');
    expect(attr(tagOf(html, 'pane-left-dev-NET')!, 'aria-pressed')).toBe('true');
    expect(html).not.toContain('Drop files');

    const queue: Listing = {
      path: 'NET:/b1', crumbs: [{ label: 'NET:', path: 'NET:' }, { label: 'A500 bench', path: 'NET:/b1' }], writable: true, readOnlyReason: null, disk: null,
      meta: '1 waiting · 0.0 of 16 MB', queue: { deviceId: 'b1', files: 1, bytes: 5 },
      // C17: two rows may share a name, and a name may hold a /.
      entries: [entry('Mods/a.mod', 'file', { path: 'NET:/b1/t1', marks: ['Waiting'] }), entry('Mods/a.mod', 'file', { path: 'NET:/b1/t2', marks: ['Delivered · saved as a_2.mod'] })],
    };
    const q = render({ listing: queue });
    expect(rows(q)).toHaveLength(2);
    for (const t of rows(q)) expect(attr(t, 'draggable')).toBe('false');
    expect(q).toContain('>Delivered · saved as a_2.mod<');
    expect(q).toMatch(/data-testid="pane-left-foot"[^>]*>(<[^>]*>)*1 waiting · 0\.0 of 16 MB · Drop files to send them/);
    // Elsewhere rows still drag.
    expect(attr(rows(render({ listing: stashListing }))[0], 'draggable')).toBe('true');
  });
});

describe('the filter and Show .info (increment 4)', () => {
  it('draws only the rows the filter keeps and says N of M in the foot', () => {
    const h = render({ view: { filter: 'ass', hideInfo: false } });
    expect(h).toContain('data-name="Assign"');
    expect(h).not.toContain('data-name="List"');
    expect(tagOf(h, 'pane-left-filter')).toMatch(/value="ass"/);
    expect(h).toMatch(/data-testid="pane-left-foot"[^>]*>1 of 3 shown</);
  });
  it('says when nothing matches', () => {
    const h = render({ view: { filter: 'zzz', hideInfo: false } });
    expect(h).toContain('No names match “zzz”.');
    expect(h).toContain('data-testid="pane-left-no-match"');
  });
  it('says when only .info files are hidden', () => {
    const only = { ...diskListing, entries: [entry('Disk.info', 'file')] };
    expect(render({ listing: only, view: { filter: '', hideInfo: true } })).toContain('Only .info files here — turn on Show .info to see them.');
  });
  it('has the Show .info switch only where files live, with its state in words', () => {
    const on = render({ listing: { ...diskListing, disk: { diskId: 'd' } as Listing['disk'] } });
    expect(on).toContain('data-testid="pane-left-show-info"');
    expect(tagOf(on, 'pane-left-show-info')).toMatch(/aria-checked="true"/);
    expect(on).toContain('Shown');
    const off = render({ listing: stashListing, view: { filter: '', hideInfo: true } });
    expect(tagOf(off, 'pane-left-show-info')).toMatch(/aria-checked="false"/);
    expect(off).toContain('Hidden');
    expect(render({ listing: rootListing })).not.toContain('data-testid="pane-left-show-info"');
    expect(render({ listing: rootListing })).toContain('data-testid="pane-left-filter"');
  });
  it('hides .info rows and counts them', () => {
    const withInfo = { ...diskListing, entries: [...diskListing.entries, entry('Assign.info', 'file')] };
    const h = render({ listing: withInfo, view: { filter: '', hideInfo: true } });
    expect(h).not.toContain('data-name="Assign.info"');
    expect(h).toMatch(/3 of 4 shown · 1 \.info file hidden/);
  });
  it('the foot does not blame Show .info for files the filter already hides', () => {
    const withInfo = { ...diskListing, entries: [...diskListing.entries, entry('Assign.info', 'file'), entry('Zed.info', 'file')] };
    const h = render({ listing: withInfo, view: { filter: 'ass', hideInfo: true } });
    expect(h).toMatch(/1 of 5 shown · 1 \.info file hidden/);
  });
  it('the ? names the device: stash-net in STASH:, files in a disk', () => {
    expect(render({ listing: stashListing, help: 'stash-net' })).toContain('data-testid="help-tip-stash-net"');
    expect(render({ help: 'files' })).toContain('data-testid="help-tip-files"');
  });
});
