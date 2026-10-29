import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PREFS, parsePrefs, parsePrefsPatch, applyPrefsPatch, startPagePath,
  LIBRARY_SORT_OPTIONS, BROWSE_SORT_OPTIONS, sortOptionId, sortFromOptionId,
  type SortOption, type SortDir, prefsDiff, LIBRARY_PAGE_SIZES,
} from './user-prefs-schema';

describe('user prefs defaults', () => {
  it("are today's behaviour (plus 48 titles a page): library start page, newest-added first in the grid, Browse by name", () => {
    expect(DEFAULT_PREFS).toEqual({
      startPage: 'library',
      library: { sort: { key: 'added', dir: 'desc' }, view: 'grid', pageSize: 48 },
      browse: { sort: { key: 'name', dir: 'asc' }, hideInfo: false },
      firmware: { skipPassword: false },
      files: {
        sort: { library: { key: 'name', dir: 'asc' }, stash: { key: 'date', dir: 'desc' }, net: { key: 'date', dir: 'desc' } },
        panes: { left: 'STASH', right: 'LIBRARY' }, comments: 'auto', confirmDelete: true, onClash: 'ask',
      },
    });
  });

  it('an absent or empty stored value reads as the defaults', () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({})).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('not an object')).toEqual(DEFAULT_PREFS);
  });

  it('a stored value that no longer validates falls back field by field, keeping the rest', () => {
    const p = parsePrefs({
      startPage: 'devices',
      library: { sort: { key: 'dropped-key', dir: 'asc' } },
      browse: { sort: { key: 'size', dir: 'desc' } },
      somethingOld: true,
    });
    expect(p).toEqual({
      startPage: 'devices',
      library: { sort: { key: 'added', dir: 'desc' }, view: 'grid', pageSize: 48 },
      browse: { sort: { key: 'size', dir: 'desc' }, hideInfo: false },
      firmware: { skipPassword: false },
      files: {
        sort: { library: { key: 'name', dir: 'asc' }, stash: { key: 'date', dir: 'desc' }, net: { key: 'date', dir: 'desc' } },
        panes: { left: 'STASH', right: 'LIBRARY' }, comments: 'auto', confirmDelete: true, onClash: 'ask',
      },
    });
    expect(parsePrefs({ startPage: 'nowhere' }).startPage).toBe('library');
  });

  it('never returns a shared object a caller could mutate into the defaults', () => {
    const a = parsePrefs({});
    a.library.sort.key = 'title';
    expect(DEFAULT_PREFS.library.sort.key).toBe('added');
    expect(parsePrefs({}).library.sort.key).toBe('added');
  });
});

describe('firmware.skipPassword', () => {
  it('defaults to false (the password is asked) and reads only a real true as true', () => {
    expect(DEFAULT_PREFS.firmware.skipPassword).toBe(false);
    expect(parsePrefs({ firmware: { skipPassword: true } }).firmware.skipPassword).toBe(true);
    for (const bad of [{ firmware: { skipPassword: 'yes' } }, { firmware: { skipPassword: 1 } }, { firmware: null }, { firmware: 'x' }]) {
      expect(parsePrefs(bad).firmware.skipPassword).toBe(false);
    }
  });

  it('a patch may name it as a boolean, nothing else', () => {
    expect(parsePrefsPatch({ firmware: { skipPassword: false } })).toEqual({ ok: true, patch: { firmware: { skipPassword: false } } });
    expect(parsePrefsPatch({ firmware: { skipPassword: true } }).ok).toBe(true);
    expect(parsePrefsPatch({ firmware: { skipPassword: 'true' } }).ok).toBe(false);
    expect(parsePrefsPatch({ firmware: { other: 1 } }).ok).toBe(false);
  });

  it('a patch merges over the stored value and leaves it when not named', () => {
    const on = applyPrefsPatch(parsePrefs({}), { firmware: { skipPassword: true } });
    expect(on.firmware.skipPassword).toBe(true);
    expect(applyPrefsPatch(on, { startPage: 'devices' }).firmware.skipPassword).toBe(true);
    expect(applyPrefsPatch(on, { firmware: {} }).firmware.skipPassword).toBe(true);
    expect(applyPrefsPatch(on, { firmware: { skipPassword: false } }).firmware.skipPassword).toBe(false);
  });

  it('prefsDiff never carries it: it has its own controls, and turning it on needs the password', () => {
    const saved = parsePrefs({});
    expect(prefsDiff(saved, { ...saved, firmware: { skipPassword: true } })).toEqual({});
  });
});

describe('user prefs patch', () => {
  it('accepts a partial patch and rejects unknown keys or bad values', () => {
    expect(parsePrefsPatch({ startPage: 'upload' })).toEqual({ ok: true, patch: { startPage: 'upload' } });
    expect(parsePrefsPatch({ library: { sort: { key: 'title', dir: 'asc' } } }).ok).toBe(true);
    expect(parsePrefsPatch({}).ok).toBe(true);
    expect(parsePrefsPatch({ startPage: 'admin' }).ok).toBe(false);
    expect(parsePrefsPatch({ colour: 'red' }).ok).toBe(false);
    expect(parsePrefsPatch({ library: { sort: { key: 'title' } } }).ok).toBe(false);
    expect(parsePrefsPatch({ browse: { sort: { key: 'added', dir: 'asc' } } }).ok).toBe(false);
    expect(parsePrefsPatch(null).ok).toBe(false);
  });

  it('merges a patch over the current prefs, one section at a time', () => {
    const cur = parsePrefs({ startPage: 'devices', browse: { sort: { key: 'size', dir: 'desc' } } });
    const next = applyPrefsPatch(cur, { library: { sort: { key: 'year', dir: 'asc' } } });
    expect(next).toEqual({
      startPage: 'devices',
      library: { sort: { key: 'year', dir: 'asc' }, view: 'grid', pageSize: 48 },
      browse: { sort: { key: 'size', dir: 'desc' }, hideInfo: false },
      firmware: { skipPassword: false },
      files: {
        sort: { library: { key: 'name', dir: 'asc' }, stash: { key: 'date', dir: 'desc' }, net: { key: 'date', dir: 'desc' } },
        panes: { left: 'STASH', right: 'LIBRARY' }, comments: 'auto', confirmDelete: true, onClash: 'ask',
      },
    });
    // The input is untouched.
    expect(cur.library.sort).toEqual({ key: 'added', dir: 'desc' });
  });
});

describe('library.view (which view /library opens in)', () => {
  it('defaults to the grid, and reads a stored table back', () => {
    expect(DEFAULT_PREFS.library.view).toBe('grid');
    expect(parsePrefs({ library: { view: 'table' } }).library).toEqual({ sort: { key: 'added', dir: 'desc' }, view: 'table', pageSize: 48 });
  });

  it('a stored view that no longer validates falls back to the grid and keeps the sort', () => {
    for (const bad of ['list', 1, null, { v: 'table' }]) {
      expect(parsePrefs({ library: { sort: { key: 'title', dir: 'asc' }, view: bad } }).library)
        .toEqual({ sort: { key: 'title', dir: 'asc' }, view: 'grid', pageSize: 48 });
    }
  });

  it('a patch may name grid or table, nothing else', () => {
    expect(parsePrefsPatch({ library: { view: 'table' } })).toEqual({ ok: true, patch: { library: { view: 'table' } } });
    expect(parsePrefsPatch({ library: { view: 'grid', sort: { key: 'title', dir: 'asc' } } }).ok).toBe(true);
    expect(parsePrefsPatch({ library: { view: 'list' } }).ok).toBe(false);
  });

  it('a patch sets the view without touching the sort, and a sort patch leaves the view', () => {
    const cur = parsePrefs({ library: { sort: { key: 'year', dir: 'asc' } } });
    const table = applyPrefsPatch(cur, { library: { view: 'table' } });
    expect(table.library).toEqual({ sort: { key: 'year', dir: 'asc' }, view: 'table', pageSize: 48 });
    expect(applyPrefsPatch(table, { library: { sort: { key: 'title', dir: 'asc' } } }).library)
      .toEqual({ sort: { key: 'title', dir: 'asc' }, view: 'table', pageSize: 48 });
    expect(cur.library.view).toBe('grid');
  });

  it('prefsDiff names the view only when it changed, and alongside a changed sort', () => {
    const saved = parsePrefs({});
    expect(prefsDiff(saved, { ...saved, library: { ...saved.library, view: 'table' } }))
      .toEqual({ library: { view: 'table' } });
    expect(prefsDiff(saved, { ...saved, library: { sort: { key: 'title', dir: 'asc' }, view: 'table', pageSize: 48 } }))
      .toEqual({ library: { sort: { key: 'title', dir: 'asc' }, view: 'table' } });
  });
});

describe('library.pageSize (titles per page, grid and table alike)', () => {
  it('defaults to 48 and offers 24, 48, 96, 192 and all', () => {
    expect(DEFAULT_PREFS.library.pageSize).toBe(48);
    expect(LIBRARY_PAGE_SIZES).toEqual([24, 48, 96, 192, 'all']);
    for (const size of LIBRARY_PAGE_SIZES) expect(parsePrefs({ library: { pageSize: size } }).library.pageSize).toBe(size);
  });

  it('a stored size that no longer validates falls back to 48 and keeps the rest', () => {
    for (const bad of [50, 0, '48', null, -1]) {
      expect(parsePrefs({ library: { view: 'table', pageSize: bad } }).library)
        .toEqual({ sort: { key: 'added', dir: 'desc' }, view: 'table', pageSize: 48 });
    }
  });

  it('a patch may name one of the sizes, nothing else, and leaves the view and the sort', () => {
    expect(parsePrefsPatch({ library: { pageSize: 96 } })).toEqual({ ok: true, patch: { library: { pageSize: 96 } } });
    expect(parsePrefsPatch({ library: { pageSize: 'all' } }).ok).toBe(true);
    expect(parsePrefsPatch({ library: { pageSize: 50 } }).ok).toBe(false);
    const cur = parsePrefs({ library: { view: 'table', sort: { key: 'year', dir: 'asc' } } });
    expect(applyPrefsPatch(cur, { library: { pageSize: 'all' } }).library)
      .toEqual({ sort: { key: 'year', dir: 'asc' }, view: 'table', pageSize: 'all' });
  });

  it('prefsDiff names the size only when it changed', () => {
    const saved = parsePrefs({});
    expect(prefsDiff(saved, { ...saved, library: { ...saved.library, pageSize: 192 } })).toEqual({ library: { pageSize: 192 } });
    expect(prefsDiff(saved, saved)).toEqual({});
  });
});

describe('start page', () => {
  it('maps each choice to its route (the stored value upload means /files)', () => {
    expect(startPagePath('library')).toBe('/library');
    expect(startPagePath('devices')).toBe('/devices');
    expect(startPagePath('upload')).toBe('/files');
  });
});

describe('sort options', () => {
  it('every option round-trips through its id, and the default is offered', () => {
    const lists: readonly (readonly SortOption<{ key: string; dir: SortDir }>[])[] = [LIBRARY_SORT_OPTIONS, BROWSE_SORT_OPTIONS];
    for (const opts of lists) {
      const ids = opts.map((o) => sortOptionId(o.sort));
      expect(new Set(ids).size).toBe(ids.length);
      for (const o of opts) expect(sortFromOptionId(opts, sortOptionId(o.sort))).toEqual(o.sort);
    }
    expect(LIBRARY_SORT_OPTIONS.map((o) => o.sort)).toContainEqual(DEFAULT_PREFS.library.sort);
    expect(BROWSE_SORT_OPTIONS.map((o) => o.sort)).toContainEqual(DEFAULT_PREFS.browse.sort);
    expect(sortFromOptionId(LIBRARY_SORT_OPTIONS, 'bogus')).toBeNull();
  });
});

describe('prefsDiff', () => {
  it('names only what changed, so a save cannot overwrite a setting changed elsewhere', () => {
    const saved = parsePrefs({});
    expect(prefsDiff(saved, saved)).toEqual({});
    expect(prefsDiff(saved, { ...saved, startPage: 'devices' })).toEqual({ startPage: 'devices' });
    expect(prefsDiff(saved, { ...saved, browse: { ...saved.browse, sort: { key: 'size', dir: 'desc' } } }))
      .toEqual({ browse: { sort: { key: 'size', dir: 'desc' } } });
    expect(prefsDiff(saved, { ...saved, library: { ...saved.library, sort: { key: 'title', dir: 'asc' } } }))
      .toEqual({ library: { sort: { key: 'title', dir: 'asc' } } });
  });
});

describe('browse.hideInfo (A5)', () => {
  it('defaults to showing .info files, and a stored true is kept', () => {
    expect(DEFAULT_PREFS.browse.hideInfo).toBe(false);
    expect(parsePrefs({ browse: { hideInfo: true } }).browse.hideInfo).toBe(true);
    expect(parsePrefs({ browse: { hideInfo: 'yes' } }).browse.hideInfo).toBe(false);
  });

  it('is patched on its own, keeping the sort', () => {
    const r = parsePrefsPatch({ browse: { hideInfo: true } });
    if (!r.ok) throw new Error(r.error);
    const next = applyPrefsPatch(parsePrefs({ browse: { sort: { key: 'size', dir: 'desc' } } }), r.patch);
    expect(next.browse).toEqual({ sort: { key: 'size', dir: 'desc' }, hideInfo: true });
  });
});

describe('files.sort (Files manager)', () => {
  const FILES_DEFAULT = {
    sort: {
      library: { key: 'name', dir: 'asc' },
      stash: { key: 'date', dir: 'desc' },
      net: { key: 'date', dir: 'desc' },
    },
    panes: { left: 'STASH', right: 'LIBRARY' },
    comments: 'auto',
    confirmDelete: true,
    onClash: 'ask',
  };
  it('defaults are present', () => {
    expect(DEFAULT_PREFS.files).toEqual(FILES_DEFAULT);
    expect(parsePrefs(null).files).toEqual(FILES_DEFAULT);
  });
  it('stored prefs from before this change have no files key and read the defaults', () => {
    const old = { startPage: 'devices', library: { sort: { key: 'title', dir: 'asc' } }, browse: { hideInfo: true } };
    const p = parsePrefs(old);
    expect(p.files).toEqual(FILES_DEFAULT);
    expect(p.startPage).toBe('devices');
  });
  it('a bad stored sort falls back for that device only', () => {
    const p = parsePrefs({ files: { sort: { library: { key: 'nope', dir: 'asc' }, stash: { key: 'size', dir: 'asc' } } } });
    expect(p.files.sort.library).toEqual({ key: 'name', dir: 'asc' });
    expect(p.files.sort.stash).toEqual({ key: 'size', dir: 'asc' });
  });
  it('a patch setting files.sort.library round-trips', () => {
    const r = parsePrefsPatch({ files: { sort: { library: { key: 'size', dir: 'desc' } } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = applyPrefsPatch(parsePrefs({}), r.patch);
    expect(next.files.sort.library).toEqual({ key: 'size', dir: 'desc' });
    expect(next.files.sort.stash).toEqual({ key: 'date', dir: 'desc' });
    expect(parsePrefs(JSON.parse(JSON.stringify(next))).files).toEqual(next.files);
  });
  it('protection is a valid key', () => {
    expect(parsePrefsPatch({ files: { sort: { net: { key: 'protection', dir: 'asc' } } } }).ok).toBe(true);
  });
  it('unknown keys are refused', () => {
    expect(parsePrefsPatch({ files: { colour: 1 } }).ok).toBe(false);
    expect(parsePrefsPatch({ files: { sort: { elsewhere: { key: 'name', dir: 'asc' } } } }).ok).toBe(false);
    expect(parsePrefsPatch({ files: { sort: { library: { key: 'name', dir: 'asc', x: 1 } } } }).ok).toBe(false);
    expect(parsePrefsPatch({ files: { sort: { library: { key: 'added', dir: 'asc' } } } }).ok).toBe(false);
  });
  it('prefsDiff names only a changed files sort', () => {
    const saved = parsePrefs({});
    const to = { ...saved, files: { ...saved.files, sort: { ...saved.files.sort, stash: { key: 'name' as const, dir: 'asc' as const } } } };
    expect(prefsDiff(saved, to)).toEqual({ files: { sort: { stash: { key: 'name', dir: 'asc' } } } });
    expect(prefsDiff(saved, saved)).toEqual({});
  });
});

describe('Files settings (increment 4)', () => {
  it('default to today: STASH: | LIBRARY:, comments in STASH:, Delete asks, a clash asks', () => {
    expect(DEFAULT_PREFS.files.panes).toEqual({ left: 'STASH', right: 'LIBRARY' });
    expect(DEFAULT_PREFS.files.comments).toBe('auto');
    expect(DEFAULT_PREFS.files.confirmDelete).toBe(true);
    expect(DEFAULT_PREFS.files.onClash).toBe('ask');
  });
  it('old rows read the new defaults and keep their sort', () => {
    const p = parsePrefs({ files: { sort: { library: { key: 'size', dir: 'desc' } } } });
    expect(p.files.sort.library).toEqual({ key: 'size', dir: 'desc' });
    expect(p.files.panes).toEqual({ left: 'STASH', right: 'LIBRARY' });
    expect(p.files.onClash).toBe('ask');
    expect(p.files.confirmDelete).toBe(true);
  });
  it('a bad new field falls back alone', () => {
    const p = parsePrefs({ files: { onClash: 'overwrite', confirmDelete: 'no', comments: 'always', panes: { left: 'NET', right: 'DH0' } } });
    expect(p.files.onClash).toBe('ask');
    expect(p.files.confirmDelete).toBe(true);     // only a real false turns the confirm off
    expect(p.files.comments).toBe('always');
    expect(p.files.panes).toEqual({ left: 'NET', right: 'LIBRARY' });
  });
  it('a patch is strict', () => {
    expect(parsePrefsPatch({ files: { onClash: 'replace' } }).ok).toBe(true);
    expect(parsePrefsPatch({ files: { panes: { left: 'NET' } } }).ok).toBe(true);
    expect(parsePrefsPatch({ files: { onClash: 'overwrite' } }).ok).toBe(false);
    expect(parsePrefsPatch({ files: { confirmDelete: 'no' } }).ok).toBe(false);
    expect(parsePrefsPatch({ files: { panes: { middle: 'NET' } } }).ok).toBe(false);
  });
  it('apply merges one field, keeping the sort and the other pane', () => {
    const p = applyPrefsPatch(parsePrefs({}), { files: { panes: { right: 'NET' }, confirmDelete: false } });
    expect(p.files.panes).toEqual({ left: 'STASH', right: 'NET' });
    expect(p.files.confirmDelete).toBe(false);
    expect(p.files.sort).toEqual(DEFAULT_PREFS.files.sort);
  });
  it('prefsDiff names only the Files fields that changed', () => {
    const from = parsePrefs({});
    const to = applyPrefsPatch(from, { files: { onClash: 'skip', panes: { left: 'LIBRARY' } } });
    expect(prefsDiff(from, to)).toEqual({ files: { onClash: 'skip', panes: { left: 'LIBRARY' } } });
    expect(prefsDiff(to, to)).toEqual({});
  });
});
