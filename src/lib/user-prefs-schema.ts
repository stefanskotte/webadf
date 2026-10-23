import { z } from 'zod';

/**
 * Per-USER web app preferences (HANDOFF §4 "Per-user web app settings",
 * 2026-10-18): settings that follow a person across browsers, not the org or
 * the board. Stored as one JSON document per user (user_prefs.prefs) and
 * read through `parsePrefs`, so the stored shape can grow without a
 * migration per setting.
 *
 * Client-safe: no database import. The server side is src/lib/user-prefs.ts
 * (getUserPrefs / setUserPrefs); the browser saves through
 * PATCH /api/me/prefs (src/lib/user-prefs-client.ts).
 *
 * Every default is TODAY'S behaviour, so a user who never opens Preferences
 * sees exactly the app as it was.
 *
 * Adding a preference: add the field to `prefsSchema` with a `.catch(default)`,
 * to DEFAULT_PREFS, and to `prefsPatchSchema` (optional, strict). Nothing
 * else -- old rows simply read the new default.
 */

export const START_PAGES = ['library', 'devices', 'upload'] as const;
export type StartPage = (typeof START_PAGES)[number];

const START_PAGE_PATHS: Record<StartPage, string> = {
  library: '/library',
  devices: '/devices',
  // The Upload page's route is still /ingest (top-nav.tsx explains why).
  upload: '/ingest',
};

/** Where the app lands for this choice: after sign-in and on the root URL. */
export function startPagePath(p: StartPage): string {
  return START_PAGE_PATHS[p];
}

export const SORT_DIRS = ['asc', 'desc'] as const;
export type SortDir = (typeof SORT_DIRS)[number];

/**
 * The library's sort keys. The grid and the table both show listGames' order,
 * so this one setting orders both; a future sortable table header would save
 * the same `{ library: { sort: { key, dir } } }` patch (savePrefs in the
 * browser, setUserPrefs on the server). `added` (newest first) is the order
 * the library has always had.
 */
export const LIBRARY_SORT_KEYS = ['added', 'title', 'year', 'publisher', 'size', 'disks'] as const;
export type LibrarySortKey = (typeof LIBRARY_SORT_KEYS)[number];
export type LibrarySort = { key: LibrarySortKey; dir: SortDir };

/**
 * Which view /library opens in when the address names none (`?view=`
 * always wins). The grid is what the library has always opened in.
 */
export const LIBRARY_VIEWS = ['grid', 'table'] as const;
export type LibraryViewMode = (typeof LIBRARY_VIEWS)[number];

/**
 * Titles per page in /library, the grid and the table alike (operator 2026-10-22). 48 by default -- the one default
 * here that is NOT the library's old behaviour (everything on one page), chosen by the operator; 'all' gives that
 * back. 24/48/96/192 split evenly over the grid's 2, 3, 4, 6 and 8 columns.
 */
export const LIBRARY_PAGE_SIZES = [24, 48, 96, 192, 'all'] as const;
export type LibraryPageSize = (typeof LIBRARY_PAGE_SIZES)[number];
const libraryPageSizeSchema = z.union([z.literal(24), z.literal(48), z.literal(96), z.literal(192), z.literal('all')]);

/** A disk's Browse list. Folders always come before files, whatever the key. */
export const BROWSE_SORT_KEYS = ['name', 'size', 'date'] as const;
export type BrowseSortKey = (typeof BROWSE_SORT_KEYS)[number];
export type BrowseSort = { key: BrowseSortKey; dir: SortDir };

export type UserPrefs = {
  startPage: StartPage;
  library: { sort: LibrarySort; view: LibraryViewMode; pageSize: LibraryPageSize };
  /** `hideInfo`: the disk browser leaves out Workbench .info icon files (A5). */
  browse: { sort: BrowseSort; hideInfo: boolean };
  /**
   * `skipPassword`: the Update button on Devices does not ask for this user's
   * password (step-up, src/lib/step-up.ts). Per USER, never per org: another
   * member keeps the prompt until they turn it on themselves.
   *
   * Turning it ON needs the password: PATCH /api/me/prefs refuses `true`
   * (`password_required`) and only POST /api/me/prefs/firmware-skip-password,
   * which checks the password through the same throttle as the firmware
   * route, may set it. Otherwise a stolen session cookie -- the one thing
   * step-up defends against -- could flip it and walk past the prompt.
   * Turning it OFF is free. A failed read is the default, false: fail safe.
   */
  firmware: { skipPassword: boolean };
};

/** Fresh objects every call: a caller may mutate what it gets back. */
function defaults(): UserPrefs {
  return {
    startPage: 'library',
    library: { sort: { key: 'added', dir: 'desc' }, view: 'grid', pageSize: 48 },
    browse: { sort: { key: 'name', dir: 'asc' }, hideInfo: false },
    firmware: { skipPassword: false },
  };
}

export const DEFAULT_PREFS: Readonly<UserPrefs> = Object.freeze(defaults());

const librarySortSchema = z.object({ key: z.enum(LIBRARY_SORT_KEYS), dir: z.enum(SORT_DIRS) });
const browseSortSchema = z.object({ key: z.enum(BROWSE_SORT_KEYS), dir: z.enum(SORT_DIRS) });

/**
 * Reading is TOLERANT: each field that is missing or no longer valid (a key
 * a later version dropped, say) falls back to its own default and the rest
 * are kept. A stored preference must never break a page.
 */
const prefsSchema = z.object({
  startPage: z.enum(START_PAGES).catch(() => defaults().startPage),
  library: z.object({
    sort: librarySortSchema.catch(() => defaults().library.sort),
    view: z.enum(LIBRARY_VIEWS).catch(() => defaults().library.view),
    pageSize: libraryPageSizeSchema.catch(() => defaults().library.pageSize),
  }).catch(() => defaults().library),
  browse: z.object({
    sort: browseSortSchema.catch(() => defaults().browse.sort),
    hideInfo: z.boolean().catch(false),
  }).catch(() => defaults().browse),
  // Only a real boolean `true` reads as true; anything else is the prompt.
  firmware: z.object({
    skipPassword: z.boolean().catch(false),
  }).catch(() => defaults().firmware),
});

export function parsePrefs(raw: unknown): UserPrefs {
  const r = prefsSchema.safeParse(raw ?? {});
  return r.success ? r.data : defaults();
}

/**
 * Writing is STRICT: a patch naming an unknown setting or a bad value is
 * refused whole, so nothing invalid is ever stored. A sort is replaced as a
 * pair (key and direction together).
 */
const prefsPatchSchema = z.strictObject({
  startPage: z.enum(START_PAGES).optional(),
  library: z.strictObject({
    sort: librarySortSchema.strict().optional(),
    view: z.enum(LIBRARY_VIEWS).optional(),
    pageSize: libraryPageSizeSchema.optional(),
  }).optional(),
  browse: z.strictObject({ sort: browseSortSchema.strict().optional(), hideInfo: z.boolean().optional() }).optional(),
  // Valid here either way; PATCH /api/me/prefs refuses `true` itself (see
  // UserPrefs.firmware), so the password-checked endpoint can share setUserPrefs.
  firmware: z.strictObject({ skipPassword: z.boolean().optional() }).optional(),
});

export type PrefsPatch = z.infer<typeof prefsPatchSchema>;

export function parsePrefsPatch(raw: unknown): { ok: true; patch: PrefsPatch } | { ok: false; error: string } {
  const r = prefsPatchSchema.safeParse(raw);
  return r.success ? { ok: true, patch: r.data } : { ok: false, error: z.prettifyError(r.error) };
}

/** `cur` with `patch` laid over it, one section deep. Pure; `cur` is not touched. */
export function applyPrefsPatch(cur: UserPrefs, patch: PrefsPatch): UserPrefs {
  return {
    startPage: patch.startPage ?? cur.startPage,
    library: {
      sort: { ...(patch.library?.sort ?? cur.library.sort) },
      view: patch.library?.view ?? cur.library.view,
      pageSize: patch.library?.pageSize ?? cur.library.pageSize,
    },
    browse: {
      sort: { ...(patch.browse?.sort ?? cur.browse.sort) },
      hideInfo: patch.browse?.hideInfo ?? cur.browse.hideInfo,
    },
    firmware: { skipPassword: patch.firmware?.skipPassword ?? cur.firmware.skipPassword },
  };
}

const sameSort = (a: { key: string; dir: string }, b: { key: string; dir: string }) =>
  a.key === b.key && a.dir === b.dir;

/**
 * The patch that turns `from` into `to`, naming only what differs. The
 * Preferences form saves this rather than everything it shows, so a sort
 * changed in another tab since the form loaded is not put back.
 */
export function prefsDiff(from: UserPrefs, to: UserPrefs): PrefsPatch {
  const patch: PrefsPatch = {};
  if (from.startPage !== to.startPage) patch.startPage = to.startPage;
  if (!sameSort(from.library.sort, to.library.sort)) patch.library = { sort: { ...to.library.sort } };
  if (from.library.view !== to.library.view) patch.library = { ...patch.library, view: to.library.view };
  if (from.library.pageSize !== to.library.pageSize) patch.library = { ...patch.library, pageSize: to.library.pageSize };
  if (!sameSort(from.browse.sort, to.browse.sort)) patch.browse = { sort: { ...to.browse.sort } };
  if (from.browse.hideInfo !== to.browse.hideInfo) patch.browse = { ...patch.browse, hideInfo: to.browse.hideInfo };
  // `firmware` deliberately never: it has its own controls on Settings
  // (firmware-password-setting.tsx), and turning it on needs the password.
  return patch;
}

// --- The sort pickers' choices -------------------------------------------
// One labelled option per meaningful (key, dir) pair, shared by the in-page
// pickers and the Preferences page so the two can never offer different lists.

export type SortOption<S> = { sort: S; label: string };

export const LIBRARY_SORT_OPTIONS: readonly SortOption<LibrarySort>[] = [
  { sort: { key: 'added', dir: 'desc' }, label: 'Newest added' },
  { sort: { key: 'added', dir: 'asc' }, label: 'Oldest added' },
  { sort: { key: 'title', dir: 'asc' }, label: 'Title A–Z' },
  { sort: { key: 'title', dir: 'desc' }, label: 'Title Z–A' },
  { sort: { key: 'year', dir: 'desc' }, label: 'Year, newest' },
  { sort: { key: 'year', dir: 'asc' }, label: 'Year, oldest' },
  { sort: { key: 'publisher', dir: 'asc' }, label: 'Publisher A–Z' },
  { sort: { key: 'size', dir: 'desc' }, label: 'Largest first' },
  { sort: { key: 'disks', dir: 'desc' }, label: 'Most disks' },
];

export const BROWSE_SORT_OPTIONS: readonly SortOption<BrowseSort>[] = [
  { sort: { key: 'name', dir: 'asc' }, label: 'Name A–Z' },
  { sort: { key: 'name', dir: 'desc' }, label: 'Name Z–A' },
  { sort: { key: 'size', dir: 'desc' }, label: 'Largest first' },
  { sort: { key: 'size', dir: 'asc' }, label: 'Smallest first' },
  { sort: { key: 'date', dir: 'desc' }, label: 'Newest first' },
  { sort: { key: 'date', dir: 'asc' }, label: 'Oldest first' },
];

/** A stable string for a `<select>` value: "title-asc". */
export function sortOptionId(s: { key: string; dir: SortDir }): string {
  return `${s.key}-${s.dir}`;
}

export function sortFromOptionId<S extends { key: string; dir: SortDir }>(
  options: readonly SortOption<S>[], id: string,
): S | null {
  const o = options.find((x) => sortOptionId(x.sort) === id);
  return o ? { ...o.sort } : null;
}
