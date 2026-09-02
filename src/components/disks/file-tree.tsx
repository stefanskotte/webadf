'use client';

import { useState } from 'react';
import type { AdfEntry } from '@/lib/adffs';

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

  function toggle(block: number) {
    setOpenBlocks((prev) => {
      const next = new Set(prev);
      if (!next.delete(block)) next.add(block);
      return next;
    });
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
            className="flex items-center gap-3 py-1.5 text-[12.5px]"
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
              <button
                type="button"
                onClick={() => toggle(entry.block)}
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
              // no download link of its own.
              <span className="w-[68px] shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}
