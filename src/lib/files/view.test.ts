// src/lib/files/view.test.ts
import { describe, it, expect } from 'vitest';
import type { FsEntry, Listing } from './types';
import { EMPTY_SELECTION } from './selection';
import {
  isInfoName, paneRows, viewCounts, remapSelection, paneFoot, showsComment, deleteAsks, paneDefaults, paneHelpTopic,
} from './view';

const e = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({
  name, kind, path: `LIBRARY:/g/d/${name}`, size: 1, date: null, protection: null, comment: null, marks: [],
});
const rows = [e('ReadMe'), e('ReadMe.info'), e('Tools', 'dir'), e('Tools.info'), e('Disk.INFO'), e('c', 'dir')];
const byName = { key: 'name', dir: 'asc' } as const;
const listing = (path: string, disk: boolean): Listing => ({
  path, crumbs: [], entries: [], writable: true, readOnlyReason: null, meta: '',
  disk: disk ? ({ diskId: 'd' } as Listing['disk']) : null,
});

describe('isInfoName', () => {
  it('is a FILE whose name ends .info, any case', () => {
    expect(isInfoName(e('Disk.INFO'))).toBe(true);
    expect(isInfoName(e('x.info', 'dir'))).toBe(false);
    expect(isInfoName(e('info'))).toBe(false);
  });
});

describe('paneRows', () => {
  it('sorts as before when nothing is filtered (folders first)', () => {
    expect(paneRows(rows, byName, { filter: '', hideInfo: false }).map((x) => x.name))
      .toEqual(['c', 'Tools', 'Disk.INFO', 'ReadMe', 'ReadMe.info', 'Tools.info']);
  });
  it('hides .info files', () => {
    expect(paneRows(rows, byName, { filter: '', hideInfo: true }).map((x) => x.name)).toEqual(['c', 'Tools', 'ReadMe']);
  });
  it('keeps names containing the filter, case aside, trimmed', () => {
    expect(paneRows(rows, byName, { filter: ' TOOL ', hideInfo: false }).map((x) => x.name)).toEqual(['Tools', 'Tools.info']);
    expect(paneRows(rows, byName, { filter: 'tool', hideInfo: true }).map((x) => x.name)).toEqual(['Tools']);
  });
});

describe('viewCounts', () => {
  it('counts what is drawn and what Show .info hides', () => {
    expect(viewCounts(rows, { filter: '', hideInfo: true })).toEqual({ total: 6, shown: 3, infoHidden: 3 });
    expect(viewCounts(rows, { filter: 'read', hideInfo: false })).toEqual({ total: 6, shown: 2, infoHidden: 0 });
  });
});

describe('remapSelection drops rows the view hides', () => {
  it('picked rows follow their entries; a hidden one leaves the selection', () => {
    const before = paneRows(rows, byName, { filter: '', hideInfo: false });
    const after = paneRows(rows, byName, { filter: 'too', hideInfo: false });
    const sel = { anchor: 1, cursor: 3, picked: new Set([1, 3]) };   // Tools, ReadMe
    const out = remapSelection(before, after, sel);
    expect([...out.picked].map((i) => after[i].name)).toEqual(['Tools']);
    expect(out.cursor).toBe(0);
    expect(remapSelection(before, before, EMPTY_SELECTION).picked.size).toBe(0);
  });
});

describe('paneFoot', () => {
  const base = { base: '1 folder · 2 files', shown: 3, total: 3, infoHidden: 0, picked: 0, pickedSize: '' };
  it('is the base when everything is drawn', () => expect(paneFoot(base)).toBe('1 folder · 2 files'));
  it('says N of M shown, and how many .info files are hidden', () => {
    expect(paneFoot({ ...base, shown: 2, total: 6, infoHidden: 3 })).toBe('2 of 6 shown · 3 .info files hidden');
    expect(paneFoot({ ...base, shown: 1, total: 3 })).toBe('1 of 3 shown');
    expect(paneFoot({ ...base, shown: 2, total: 3, infoHidden: 1 })).toBe('2 of 3 shown · 1 .info file hidden');
  });
  it('a selection counts against the rows drawn', () => {
    expect(paneFoot({ ...base, shown: 2, total: 6, picked: 1, pickedSize: '5 KB' })).toBe('1 of 2 selected · 5 KB');
  });
});

describe('showsComment', () => {
  it('auto is STASH: only; always and never mean it', () => {
    expect(showsComment('auto', 'STASH:/Mods')).toBe(true);
    expect(showsComment('auto', 'LIBRARY:/g/d')).toBe(false);
    expect(showsComment('always', 'NET:/b')).toBe(true);
    expect(showsComment('never', 'STASH:')).toBe(false);
  });
});

describe('deleteAsks: only a disk skips the confirm', () => {
  it('asks everywhere when the setting is on', () => {
    expect(deleteAsks(true, listing('LIBRARY:/g/d', true))).toBe(true);
  });
  it('off: a disk does not ask; STASH: and NET: still do (R2)', () => {
    expect(deleteAsks(false, listing('LIBRARY:/g/d', true))).toBe(false);
    expect(deleteAsks(false, listing('STASH:/Mods', false))).toBe(true);
    expect(deleteAsks(false, listing('NET:/b1', false))).toBe(true);
    expect(deleteAsks(false, null)).toBe(true);
  });
});

describe('paneDefaults maps devices to roots', () => {
  it('maps each choice to its root', () => {
    expect(paneDefaults({ left: 'NET', right: 'STASH' })).toEqual({ left: 'NET:', right: 'STASH:' });
  });
});

describe('paneHelpTopic', () => {
  it('STASH: and NET: explain themselves; LIBRARY: is the Files topic', () => {
    expect(paneHelpTopic('STASH:/x')).toBe('stash-net');
    expect(paneHelpTopic('NET:')).toBe('stash-net');
    expect(paneHelpTopic('LIBRARY:/g/d')).toBe('files');
  });
});
