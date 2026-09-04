'use client';

import { useState } from 'react';
import type { AdfEntry } from '@/lib/adffs';
import { useFileEdit, MAX_NAME_LENGTH } from './file-actions';

/**
 * Directories first, then case-insensitive name order.
 *
 * AmigaDOS stores entries by hash chain, not alphabetically -- a raw listing
 * looks shuffled -- so every level of the tree is re-sorted before it is
 * rendered, not just the root.
 */
function sortEntries(entries: AdfEntry[]): AdfEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

interface VisibleRow {
  entry: AdfEntry;
  depth: number;
  open: boolean;
}

/**
 * The tree, flattened into exactly the rows on screen, in the order they are
 * painted.
 *
 * This exists for the striping. Zebra rows have to alternate down the VISIBLE
 * list, and a recursive component cannot know its own position in that list --
 * each level would restart its own odd/even count, so expanding a directory
 * puts two same-shaded rows next to each other at every boundary, which reads
 * as a rendering bug rather than a stripe. Flattening first makes the row
 * index the single source of truth for the shade.
 *
 * It also moves `open` out of the row and into the tree: per-row state would
 * be destroyed whenever the flattening changed a row's position.
 */
function flatten(entries: AdfEntry[], openBlocks: Set<number>, depth = 0): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const entry of sortEntries(entries)) {
    const open = entry.kind === 'dir' && openBlocks.has(entry.block);
    rows.push({ entry, depth, open });
    if (open && entry.kind === 'dir') {
      rows.push(...flatten(entry.children, openBlocks, depth + 1));
    }
  }
  return rows;
}

export function FileTree({ entries, diskId }: { entries: AdfEntry[]; diskId: string }) {
  const [openBlocks, setOpenBlocks] = useState<ReadonlySet<number>>(() => new Set());
  const { disabled, busy, runEdit } = useFileEdit();

  // Which single row, if any, has its rename or delete form expanded. Kept
  // here rather than per-row, and mutually exclusive with each other: at
  // most one row is ever mid-edit, which keeps the inline layout simple
  // without losing anything a person would actually want to do at once.
  const [renameBlock, setRenameBlock] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteBlock, setDeleteBlock] = useState<number | null>(null);

  function toggle(block: number) {
    setOpenBlocks((prev) => {
      const next = new Set(prev);
      if (!next.delete(block)) next.add(block);
      return next;
    });
  }

  function startRename(entry: AdfEntry) {
    setDeleteBlock(null);
    setRenameBlock(entry.block);
    setRenameValue(entry.name.slice(0, MAX_NAME_LENGTH));
  }

  function cancelRename() {
    setRenameBlock(null);
    setRenameValue('');
  }

  function submitRename(block: number) {
    const name = renameValue.trim();
    if (!name) return;
    runEdit(() => fetch(`/api/disks/${diskId}/files/${block}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }), `Renamed to "${name}"`);
    cancelRename();
  }

  function startDelete(entry: AdfEntry) {
    setRenameBlock(null);
    setDeleteBlock(entry.block);
  }

  function cancelDelete() {
    setDeleteBlock(null);
  }

  function submitDelete(block: number) {
    runEdit(
      () => fetch(`/api/disks/${diskId}/files/${block}`, { method: 'DELETE' }),
      'Deleted',
    );
    cancelDelete();
  }

  if (entries.length === 0) {
    return (
      <div className="glass-card p-5 text-[13px]" style={{ color: 'var(--muted)' }} data-testid="file-tree">
        This disk&apos;s root directory is empty.
      </div>
    );
  }

  const rows = flatten(entries, openBlocks as Set<number>);

  return (
    <div className="glass-card overflow-hidden p-3" data-testid="file-tree">
      {rows.map(({ entry, depth, open }, i) => {
        const isDir = entry.kind === 'dir';
        // The stripe is a WHITE wash, not a grey one, and the direction is
        // deliberate. The metadata columns below use --muted-2, which is
        // 5.11:1 on the plain card; darkening alternate rows by even 0.03
        // drops --faint to 4.49:1 and keeps falling, so a conventional
        // grey zebra would put the smallest text in this app under WCAG AA
        // on every other row. Washing lighter instead moves --muted-2 to
        // 5.37:1 and --faint to 4.98:1 -- the same alternation to the eye,
        // read against the card the rows sit on, but contrast goes up
        // rather than down. Do not "fix" this to a grey without re-running
        // those numbers.
        const striped = i % 2 === 1;
        return (
          <div
            key={entry.block}
            // Two lines on a phone, one line from `sm` up. The metadata
            // columns total ~312px of fixed width inside a card that is only
            // ~310px wide at 390px, so the name column computes NEGATIVE at
            // depth 0 and worse at every level of nesting, and the card's
            // own overflow-hidden clips whatever is left. Scrolling the row
            // sideways is not the alternative: Download is the row's only
            // action, so it would be the first thing pushed out of reach.
            className="flex flex-col gap-1 py-1.5 text-[12.5px] sm:flex-row sm:items-center sm:gap-3"
            style={{
              paddingLeft: `${depth * 18 + 8}px`,
              paddingRight: '8px',
              background: striped ? 'rgb(255 255 255 / 0.5)' : 'transparent',
              // Rounded so the wash reads as a band rather than a full-bleed
              // block butting against the card's own rounded corners.
              borderRadius: '6px',
            }}
            data-testid="fs-entry"
            data-name={entry.name}
          >
            {isDir ? (
              // A stable testid of its own -- not just the accessible name
              // (which happens to equal entry.name today) -- because a row
              // now legitimately holds more than one <button> (Rename,
              // Delete, and this toggle), so any test still choosing "the
              // button" by role alone would be ambiguous or, worse, silently
              // pick the wrong one if the row's button order ever changes.
              // Fix round 1 moved e2e/adf-browser.spec.ts and
              // e2e/mobile.spec.ts onto this testid for exactly that reason
              // -- do not "simplify" them back to a bare getByRole('button').
              <button
                type="button"
                onClick={() => toggle(entry.block)}
                data-testid={`fs-toggle-${entry.block}`}
                className="flex min-w-0 flex-1 items-center gap-2 text-left font-semibold"
                style={{ color: 'var(--ink)' }}
                aria-expanded={open}
              >
                <span
                  aria-hidden
                  className="inline-block transition-transform duration-150"
                  style={{ color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none' }}
                >
                  ▸
                </span>
                <span className="truncate">{entry.name}</span>
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate pl-[22px]" style={{ color: 'var(--ink)' }}>
                {entry.name}
              </span>
            )}

            {/*
              `sm:contents` rather than a second set of column rules: from
              `sm` up this wrapper generates no box at all, so the row's own
              flex lays these four out exactly as it did before the wrapper
              existed -- the desktop row is unchanged, not re-derived. Below
              `sm` it is line two, indented by the chevron's width so it
              starts under the name rather than under the arrow.
            */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] sm:contents">
              {!isDir && (
                <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
                  {entry.sizeBytes.toLocaleString()} B
                </span>
              )}
              <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
                {entry.protection}
              </span>
              <span className="w-[80px] shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted-2)' }}>
                {entry.modifiedAt ? entry.modifiedAt.toISOString().slice(0, 10) : '—'}
              </span>

              {/*
                An <a> with a real href, not a <button>: the browser streams
                the response straight to disk and shows its own progress, the
                same reasoning as the Download control on the game detail
                page (disk-row.tsx). A plain fetch-then-save would buffer the
                whole file in memory to achieve the same result.
              */}
              {!isDir ? (
                <a
                  href={`/api/disks/${diskId}/files/${entry.block}`}
                  data-testid={`fs-download-${entry.block}`}
                  className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
                >
                  Download
                </a>
              ) : (
                // Keeps the file column above aligned when a directory row has
                // no download link of its own. Only from `sm` up: on the
                // two-line layout there is no column to align to, and 68px of
                // nothing would just widen line two.
                <span className="hidden w-[68px] shrink-0 sm:block" />
              )}
            </div>

            {/*
              Rename and delete, on their own line so they never have to
              fight the responsive column rules above. INLINE expansion, not
              an overlay: opening one grows this row in normal document
              flow and pushes every row below it down, so nothing can ever
              cover a sibling row's controls the way an anchored popup did
              on the game detail page (see e2e/game-detail.spec.ts).

              Real <button>s, not <a> -- these are destructive/mutating
              actions with no href of their own, and a native anchor only
              activates on Enter, not Space, so a keyboard user tabbing here
              and pressing Space would scroll the page instead of opening the
              form. An earlier version of this file used <a href="#"> plus
              preventDefault to keep the row's `<button>` count at one for a
              test locator's sake; collection-provider.tsx already documents,
              at length, what a bare href under dnd-kit cost this repo once
              (a default action that kept firing despite stopPropagation,
              needing a document-level capture-phase preventDefault, found
              only by an e2e failure). This tree is not in a drag context
              today, but there is nothing that keeps it that way, and the
              fix -- a real <button disabled>, matching FileToolbar two files
              over -- is not worth deferring. The directory toggle now
              carries its own `fs-toggle-${block}` testid instead, so the row
              can hold more than one button without any test locator caring.
            */}
            {renameBlock === entry.block ? (
              <div className="flex flex-wrap items-center gap-2 pl-[22px]">
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value.slice(0, MAX_NAME_LENGTH))}
                  maxLength={MAX_NAME_LENGTH}
                  aria-label={`New name for ${entry.name}`}
                  data-testid={`fs-rename-name-${entry.block}`}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename(entry.block);
                    if (e.key === 'Escape') cancelRename();
                  }}
                  className="rounded border bg-transparent px-2 py-1 text-[11px]"
                  style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}
                />
                <button
                  type="button"
                  onClick={() => submitRename(entry.block)}
                  disabled={busy || !renameValue.trim()}
                  data-testid={`fs-rename-submit-${entry.block}`}
                  className="rounded px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--primary-action)' }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={cancelRename}
                  disabled={busy}
                  data-testid={`fs-rename-cancel-${entry.block}`}
                  className="rounded px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
                  style={{ color: 'var(--muted)' }}
                >
                  Cancel
                </button>
              </div>
            ) : deleteBlock === entry.block ? (
              <div className="flex flex-wrap items-center gap-2 pl-[22px]">
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  Delete &quot;{entry.name}&quot;{isDir ? ' and everything inside it' : ''}? This cannot be undone.
                </span>
                <button
                  type="button"
                  onClick={() => submitDelete(entry.block)}
                  disabled={busy}
                  data-testid={`fs-delete-confirm-${entry.block}`}
                  className="rounded px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--danger-fg)' }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={cancelDelete}
                  disabled={busy}
                  data-testid={`fs-delete-cancel-${entry.block}`}
                  className="rounded px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
                  style={{ color: 'var(--muted)' }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 pl-[22px]">
                <button
                  type="button"
                  onClick={() => startRename(entry)}
                  disabled={!!disabled}
                  title={disabled?.message}
                  data-testid={`fs-rename-${entry.block}`}
                  className="text-[11px] font-semibold underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
                  style={{ color: 'var(--muted)' }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => startDelete(entry)}
                  disabled={!!disabled}
                  title={disabled?.message}
                  data-testid={`fs-delete-${entry.block}`}
                  className="text-[11px] font-semibold underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
                  style={{ color: 'var(--muted)' }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
