// Which fields a person may edit, which authority column each one belongs to,
// and what a given edit actually changes.
//
// Pure and database-free, so the rule that decides what a scan may overwrite
// is testable without a sweep. See
// docs/superpowers/specs/2026-09-03-edit-title-details.md.

import { makeSortTitle } from '@/lib/tosec';

/**
 * The three authority groups. They exist because `games` carries three source
 * columns, not one: OpenRetro's facts must survive a later prose import and
 * vice versa, and a person fixing a typo in a description must not thereby
 * freeze their publisher against every future scan.
 */
export const GROUPS = ['identity', 'facts', 'prose'] as const;
export type Group = (typeof GROUPS)[number];

/** The column each group's authority is recorded in. */
export const GROUP_COLUMN: Record<Group, 'metadataSource' | 'factsSource' | 'proseSource'> = {
  identity: 'metadataSource',
  facts: 'factsSource',
  prose: 'proseSource',
};

/**
 * Editable fields, by group.
 *
 * `publisher` is identity even though OpenRetro also writes it: it is TOSEC's
 * column first, and a person correcting a publisher means it. openretro-apply
 * guards its publisher write on metadataSource for exactly this reason.
 *
 * `sortTitle` is deliberately absent -- it is DERIVED from title, never typed.
 */
export const GROUP_FIELDS = {
  identity: ['title', 'year', 'publisher'],
  facts: ['developer', 'players', 'genre', 'chipset'],
  prose: ['description', 'history'],
} as const satisfies Record<Group, readonly string[]>;

export type EditableField =
  | (typeof GROUP_FIELDS)['identity'][number]
  | (typeof GROUP_FIELDS)['facts'][number]
  | (typeof GROUP_FIELDS)['prose'][number];

const FIELD_GROUP = new Map<string, Group>(
  GROUPS.flatMap((g) => GROUP_FIELDS[g].map((f) => [f, g] as const)),
);

export function groupOf(field: string): Group | null {
  return FIELD_GROUP.get(field) ?? null;
}

export interface GameEditInput {
  title?: string;
  /**
   * A number, or the string an <input> gives back. normaliseYear() takes
   * either -- widening it here keeps the coercion in one place instead of
   * making every caller cast before it can validate.
   */
  year?: number | string | null;
  publisher?: string | null;
  developer?: string | null;
  players?: string | null;
  genre?: string | null;
  chipset?: string | null;
  description?: string | null;
  history?: string | null;
}

/**
 * What the row looks like now, for working out what actually changed. `year`
 * is narrowed back to a number here: it is what the DATABASE holds, never what
 * a form posted.
 */
export type GameEditCurrent =
  Omit<GameEditInput, 'title' | 'year'> & { title: string; year?: number | null };

export interface EditPlan {
  /** Column updates to apply, already including a derived sortTitle. */
  values: Record<string, string | number | null>;
  /** Groups this edit really changes -- only these get stamped 'human'. */
  touched: Group[];
}

export class EditError extends Error {}

/**
 * An empty text box means "there is no value", not "the string is empty".
 * Trimming first keeps a row of spaces from counting as a change, and from
 * being stored as one.
 */
function normaliseText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new EditError('Expected text');
  const t = v.trim();
  return t === '' ? null : t;
}

/** Rejects anything a person could not have meant. */
function normaliseYear(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw new EditError('Year must be a whole number');
  // 1978 is a few years before the Amiga existed and well before any of this
  // software did; the upper bound is only there to catch a typed-in date.
  if (n < 1978 || n > 2100) throw new EditError('Year must be between 1978 and 2100');
  return n;
}

/**
 * Work out the update, and which groups it touches.
 *
 * Only genuinely CHANGED fields count. Submitting a form untouched must stamp
 * nothing -- otherwise merely opening the editor would quietly freeze every
 * group on the row against all future scans, which is the opposite of what
 * the person did.
 */
export function planEdit(input: GameEditInput, current: GameEditCurrent): EditPlan {
  const values: Record<string, string | number | null> = {};
  const touched = new Set<Group>();

  for (const [field, raw] of Object.entries(input)) {
    const group = groupOf(field);
    if (group === null) continue; // Unknown key: ignored, never trusted.

    const next = field === 'year' ? normaliseYear(raw) : normaliseText(raw);

    if (field === 'title') {
      // Narrowed for the compiler as much as for the reader: `year` is the
      // only numeric field and it is handled by the branch above, so a title
      // here is always text.
      const title = typeof next === 'number' ? String(next) : next;
      if (title === null) throw new EditError('A title cannot be empty');
      if (title === current.title) continue;
      values.title = title;
      // sortTitle is NOT NULL, is what games_org_sort_idx orders by, and
      // (sortTitle, year) is the key mergeDuplicates collapses on -- so a
      // title edit that skipped it would leave the row sorting and merging
      // under its OLD name. makeSortTitle, not a local rule, so a human row
      // sorts exactly like a machine one.
      values.sortTitle = makeSortTitle(title);
      touched.add('identity');
      continue;
    }

    const before = (current as Record<string, unknown>)[field] ?? null;
    if (next === before) continue;
    values[field] = next;
    touched.add(group);
  }

  return { values, touched: GROUPS.filter((g) => touched.has(g)) };
}
