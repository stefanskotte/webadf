import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PREFS, parsePrefs, parsePrefsPatch, applyPrefsPatch, startPagePath,
  LIBRARY_SORT_OPTIONS, BROWSE_SORT_OPTIONS, sortOptionId, sortFromOptionId,
  type SortOption, type SortDir, prefsDiff,
} from './user-prefs-schema';

describe('user prefs defaults', () => {
  it("are today's behaviour: library start page, newest-added first, Browse by name", () => {
    expect(DEFAULT_PREFS).toEqual({
      startPage: 'library',
      library: { sort: { key: 'added', dir: 'desc' } },
      browse: { sort: { key: 'name', dir: 'asc' } },
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
      library: { sort: { key: 'added', dir: 'desc' } },
      browse: { sort: { key: 'size', dir: 'desc' } },
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
      library: { sort: { key: 'year', dir: 'asc' } },
      browse: { sort: { key: 'size', dir: 'desc' } },
    });
    // The input is untouched.
    expect(cur.library.sort).toEqual({ key: 'added', dir: 'desc' });
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
    expect(prefsDiff(saved, { ...saved, browse: { sort: { key: 'size', dir: 'desc' } } }))
      .toEqual({ browse: { sort: { key: 'size', dir: 'desc' } } });
    expect(prefsDiff(saved, { ...saved, library: { sort: { key: 'title', dir: 'asc' } } }))
      .toEqual({ library: { sort: { key: 'title', dir: 'asc' } } });
  });
});
