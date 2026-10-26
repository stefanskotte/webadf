// Library multi-select (spec 2026-10-26): the selection's state and words. Pure -- no React, no database -- so it is
// unit-tested in node and imported by the client components. Server result types come in with `import type` only.
import type { LibraryView } from '@/lib/library-view';

/** One request's cap, the same as the disk files' bulk route (Ruling 6). */
export const SELECTION_CAP = 1000;
export const CAP_TITLE = 'Up to 1,000 titles at a time';

/** What the dialogs need to name a title that is not on the current page. */
export interface SelectedTitle { title: string; year: number | null; diskCount: number }
export interface PageTitle extends SelectedTitle { id: string }

export interface SelectionState {
  /** The view the selection belongs to (Ruling 4): another view clears it. */
  viewKey: string;
  selecting: boolean;
  /** In insertion order. */
  selected: ReadonlyMap<string, SelectedTitle>;
}

export type SelectionAction =
  | { type: 'start' }
  | { type: 'cancel' }
  | { type: 'toggle'; title: PageTitle }
  | { type: 'togglePage'; page: readonly PageTitle[] }
  | { type: 'view'; viewKey: string };

export function viewKeyOf(view: LibraryView): string {
  return view.kind === 'collection' ? `collection:${view.id}` : view.kind;
}

export function initSelection(viewKey: string): SelectionState {
  return { viewKey, selecting: false, selected: new Map() };
}

const facts = ({ title, year, diskCount }: PageTitle): SelectedTitle => ({ title, year, diskCount });

export function pageCheck(selected: ReadonlyMap<string, unknown>, pageIds: readonly string[]): 'none' | 'some' | 'all' {
  const n = pageIds.filter((id) => selected.has(id)).length;
  if (pageIds.length > 0 && n === pageIds.length) return 'all';
  return n === 0 ? 'none' : 'some';
}

/** Whether ticking every title of this page keeps the selection within the cap. */
export function canSelectPage(selected: ReadonlyMap<string, unknown>, pageIds: readonly string[]): boolean {
  return selected.size + pageIds.filter((id) => !selected.has(id)).length <= SELECTION_CAP;
}

export function offPageCount(selected: ReadonlyMap<string, unknown>, pageIds: readonly string[]): number {
  const here = new Set(pageIds);
  let n = 0;
  for (const id of selected.keys()) if (!here.has(id)) n++;
  return n;
}

export function selectionReducer(s: SelectionState, a: SelectionAction): SelectionState {
  switch (a.type) {
    case 'start':
      return s.selecting ? s : { ...s, selecting: true, selected: new Map() };
    case 'cancel':
      return initSelection(s.viewKey);
    case 'view':
      return a.viewKey === s.viewKey ? s : initSelection(a.viewKey);
    case 'toggle': {
      if (!s.selecting) return s;
      const next = new Map(s.selected);
      if (next.has(a.title.id)) next.delete(a.title.id);
      else if (next.size >= SELECTION_CAP) return s;
      else next.set(a.title.id, facts(a.title));
      return { ...s, selected: next };
    }
    case 'togglePage': {
      if (!s.selecting) return s;
      const pageIds = a.page.map((p) => p.id);
      const next = new Map(s.selected);
      if (pageCheck(s.selected, pageIds) === 'all') {
        for (const id of pageIds) next.delete(id);
        return { ...s, selected: next };
      }
      if (!canSelectPage(s.selected, pageIds)) return s;
      for (const p of a.page) if (!next.has(p.id)) next.set(p.id, facts(p));
      return { ...s, selected: next };
    }
  }
}

const n0 = (n: number) => n.toLocaleString('en-US');
export const titlesWord = (n: number) => `${n0(n)} ${n === 1 ? 'title' : 'titles'}`;
export const disksWord = (n: number) => `${n0(n)} ${n === 1 ? 'disk' : 'disks'}`;
export const countText = (n: number) => (n === 0 ? 'No titles selected' : `${titlesWord(n)} selected`);
/** The disk files' "(n not shown)" in this bar's words, so a Delete never surprises (spec §1.3). */
export const offPageText = (k: number) => ` · ${n0(k)} on other pages`;
