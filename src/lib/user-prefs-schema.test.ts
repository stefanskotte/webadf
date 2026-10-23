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
  it('maps each choice to its route (Upload lives at /ingest)', () => {
    expect(startPagePath('library')).toBe('/library');
    expect(startPagePath('devices')).toBe('/devices');
    expect(startPagePath('upload')).toBe('/ingest');
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
