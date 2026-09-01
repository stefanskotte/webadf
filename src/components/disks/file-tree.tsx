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

function EntryRow({ entry, diskId, depth }: { entry: AdfEntry; diskId: string; depth: number }) {
  const [open, setOpen] = useState(false);
  const isDir = entry.kind === 'dir';
  const children = isDir ? sortEntries(entry.children) : [];

  return (
    <div>
      <div
        className="flex items-center gap-3 border-b py-1.5 text-[12.5px] last:border-b-0"
        style={{ paddingLeft: `${depth * 18 + 8}px`, borderColor: 'var(--glass-strong)' }}
        data-testid="fs-entry"
        data-name={entry.name}
      >
        {isDir ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left font-semibold"
            style={{ color: 'var(--ink)' }}
            aria-expanded={open}
          >
            <span aria-hidden style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
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
          // Keeps the file column above aligned when a directory row has no
          // download link of its own.
          <span className="w-[68px] shrink-0" />
        )}
      </div>

      {isDir && open && children.length > 0 && (
        <div>
          {children.map((child) => (
            <EntryRow key={child.block} entry={child} diskId={diskId} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ entries, diskId }: { entries: AdfEntry[]; diskId: string }) {
  const sorted = sortEntries(entries);

  if (sorted.length === 0) {
    return (
      <div className="glass-card p-5 text-[13px]" style={{ color: 'var(--muted)' }} data-testid="file-tree">
        This disk&apos;s root directory is empty.
      </div>
    );
  }

  return (
    <div className="glass-card p-3" data-testid="file-tree">
      {sorted.map((entry) => (
        <EntryRow key={entry.block} entry={entry} diskId={diskId} depth={0} />
      ))}
    </div>
  );
}
