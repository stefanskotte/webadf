// Library multi-select (spec 2026-10-26): the selection's state and words. Pure -- no React, no database -- so it is
// unit-tested in node and imported by the client components. Server result types come in with `import type` only.
import type { LibraryView } from '@/lib/library-view';
import type { MoveResult } from '@/lib/collections';
import type { BulkDeleteResult } from '@/lib/disk-delete';
import type { HoldWhere, KeptTitle } from '@/lib/bulk-delete-plan';

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

/**
 * What the provider applies in render: another view, or a view with no titles left to select (emptied by another tab
 * or a refresh), drops the selection, so nothing stale is pressed or sent when titles come back.
 */
export function reconcileSelection(s: SelectionState, viewKey: string, canSelect: boolean): SelectionState {
  if (s.viewKey !== viewKey) return initSelection(viewKey);
  if (s.selecting && !canSelect) return initSelection(viewKey);
  return s;
}

/**
 * A native text/select control: Escape there belongs to the control, not to the selection. A checkbox or radio holds
 * nothing to cancel, so the selection boxes (the bar's "All on this page", a card's) do not count.
 */
export function isFormControl(target: { tagName?: string; type?: string } | null): boolean {
  const tag = target?.tagName?.toUpperCase();
  if (tag === 'INPUT') return target?.type !== 'checkbox' && target?.type !== 'radio';
  return tag === 'SELECT' || tag === 'TEXTAREA';
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
      if (!s.selecting || a.page.length === 0) return s;
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

const wasWere = (n: number) => `${n} ${n === 1 ? 'was' : 'were'}`;

/** The Move toast (spec §2.3): every owned title ended up in the target; the rest of the line says how. */
export function moveToast(r: MoveResult, name: string): string {
  let s = `Moved ${titlesWord(r.added + r.alreadyThere)} to ${name}`;
  if (r.alreadyThere > 0) s += `, ${wasWere(r.alreadyThere)} already there`;
  if (r.missing.length > 0) s += `, ${wasWere(r.missing.length)} already gone`;
  return s;
}

export const NOTHING_TO_DELETE = 'Nothing to delete: every selected title is in a drive. Eject it there first.';
export const holdText = (h: HoldWhere) => `${h.label} (${h.drive})`;
/**
 * "Turrican — In A500 (DF0)": the kept line, in holdLabel's words, so the person knows what to eject (spec §2.2).
 * A title kept with no holds was kept by the server's drift guard, not by a drive: it is never "in a drive".
 */
export const keptLine = (k: KeptTitle) => `${k.title} — ${k.holds.length === 0 ? 'could not be deleted' : k.holds.map(holdText).join(' · ')}`;
export const keptIntro = (n: number) => `${titlesWord(n)} ${n === 1 ? 'is' : 'are'} in a drive and will be kept:`;
export const stuckIntro = (n: number) => `${titlesWord(n)} could not be deleted and will be kept:`;
/** Kept titles split by why: a drive holds them, or the server's drift guard kept them (no holds). */
export function keptGroups(kept: readonly KeptTitle[]): { held: KeptTitle[]; stuck: KeptTitle[] } {
  return { held: kept.filter((k) => k.holds.length > 0), stuck: kept.filter((k) => k.holds.length === 0) };
}

/** The Delete toast (spec §2.3): what really happened at OK, which can differ from the preview. */
export function deleteToast(r: BulkDeleteResult): { title: string; description: string | undefined } {
  const { held, stuck } = keptGroups(r.kept);
  const parts: string[] = [];
  if (held.length > 0) parts.push(`Kept ${held.length} that ${held.length === 1 ? 'is' : 'are'} in a drive: ${held.map((k) => k.title).join(', ')}.`);
  if (stuck.length > 0) parts.push(`${stuck.length} could not be deleted: ${stuck.map((k) => k.title).join(', ')}.`);
  if (r.missing.length > 0) parts.push(`${wasWere(r.missing.length)} already gone.`);
  if (r.ejected.length > 0) parts.push(`Ejected from ${r.ejected.join(', ')}.`);
  return {
    title: r.deleted.length === 0 ? 'Nothing was deleted' : `Deleted ${titlesWord(r.deleted.length)}`,
    description: parts.length > 0 ? parts.join(' ') : undefined,
  };
}

/** Why a preview has nothing to delete (spec §2.2): held, already gone, kept by the drift guard, or a mix. */
export function nothingToDeleteText(kept: readonly KeptTitle[], missing: number): string {
  const { held, stuck } = keptGroups(kept);
  if (missing > 0) return 'Nothing to delete: the selected titles are in a drive or already gone.';
  if (held.length > 0 && stuck.length === 0) return NOTHING_TO_DELETE;
  if (stuck.length > 0) return 'Nothing could be deleted.';
  return 'Nothing to delete.';
}
