'use client';

import {
  createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject,
} from 'react';
import { pageHeading } from '@/components/admin/page-heading';
import {
  initSelection, isFormControl, reconcileSelection, selectionReducer, type PageTitle, type SelectedTitle, type SelectionAction,
} from '@/lib/library-selection';

export interface LibrarySelection {
  selecting: boolean;
  selected: ReadonlyMap<string, SelectedTitle>;
  /** The titles on this page, in the page's order: what "All on this page" ticks. */
  pageTitles: readonly PageTitle[];
  dispatch: (a: SelectionAction) => void;
  /** The header toggle, where Cancel and a finished operation put focus. */
  toggleRef: RefObject<HTMLButtonElement | null>;
  start: () => void;
  /** Ends selecting and clears it, nothing sent (spec §1.6), and puts focus on the toggle, else the h1. */
  cancel: () => void;
  /** Ends selecting and clears it, leaving focus to the caller (a dialog's finalFocus). */
  end: () => void;
  /** The toggle when it is on the page, else the h1: never <body>. */
  focusTarget: () => HTMLElement | null;
}

const OFF: LibrarySelection = {
  selecting: false, selected: new Map(), pageTitles: [], dispatch: () => {}, toggleRef: { current: null },
  start: () => {}, cancel: () => {}, end: () => {}, focusTarget: () => null,
};

const Ctx = createContext<LibrarySelection | null>(null);

/** The selection, or a selection that is always off outside the library page's provider. */
export function useLibrarySelection(): LibrarySelection {
  return useContext(Ctx) ?? OFF;
}

/**
 * Library multi-select (spec 2026-10-26 §1.5): one selection per view, shared by the header toggle, the bar, the grid
 * and the table. page.tsx mounts it around both the PageHeader and the CollectionsProvider.
 *
 * It survives paging, grid/table, sort and router.refresh() -- search-param navigations keep client state in this
 * Next.js. A new view key (another collection, All titles, Uncategorized) clears it, decided in render, never by an
 * effect that sets state. Leaving /library unmounts the page here (no Activity: cacheComponents is off), and the
 * layout-effect cleanup drops the selection too if Activity ever hides the page instead (preserving-ui-state.md).
 */
export function LibrarySelectionProvider({ viewKey, pageTitles, canSelect, children }: {
  viewKey: string;
  pageTitles: PageTitle[];
  /** The page shows at least one title (not an empty view, not the collections overview). */
  canSelect: boolean;
  children?: ReactNode;
}) {
  const [state, setState] = useState(() => initSelection(viewKey));
  const reconciled = reconcileSelection(state, viewKey, canSelect);
  if (reconciled !== state) setState(reconciled);
  const dispatch = useCallback((a: SelectionAction) => setState((s) => selectionReducer(s, a)), []);
  useLayoutEffect(() => () => setState((s) => initSelection(s.viewKey)), []);

  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useCallback((): HTMLElement | null => {
    const t = toggleRef.current;
    return t && t.isConnected ? t : pageHeading();
  }, []);
  const start = useCallback(() => dispatch({ type: 'start' }), [dispatch]);
  const end = useCallback(() => dispatch({ type: 'cancel' }), [dispatch]);
  const cancel = useCallback(() => { dispatch({ type: 'cancel' }); focusTarget()?.focus(); }, [dispatch, focusTarget]);

  const selecting = state.selecting && canSelect;
  const value = useMemo<LibrarySelection>(() => ({
    selecting, selected: state.selected, pageTitles, dispatch, toggleRef, start, cancel, end, focusTarget,
  }), [selecting, state.selected, pageTitles, dispatch, start, cancel, end, focusTarget]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The grid/table column. Escape there ends selecting (spec §1.1) -- from the bar, a checkbox or a row -- but never
 * from inside a dialog or a menu: their keydown bubbles here through React's portal tree, and Escape in the Move or
 * Delete dialog must close only that dialog (Review Focus 2).
 */
export function SelectionScope({ className, children }: { className: string; children: ReactNode }) {
  const { selecting, cancel } = useLibrarySelection();
  return (
    <div
      className={className}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !selecting || e.defaultPrevented) return;
        if (isFormControl(e.target as Element)) return;
        if (e.target instanceof Element && e.target.closest('[role="dialog"],[role="menu"]')) return;
        e.preventDefault();
        cancel();
      }}
    >
      {children}
    </div>
  );
}
