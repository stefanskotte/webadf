'use client';

import { useEffect, useRef, useState } from 'react';
import type { AdfEntry } from '@/lib/adffs';
import { useFileEdit } from './file-actions';
import type { DirectoryOption } from './file-tree';

/** Files and folders a delete of `tops` removes, counting everything inside a folder. */
function countAll(tops: AdfEntry[]): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  const walk = (e: AdfEntry) => {
    if (e.kind === 'dir') { folders++; e.children.forEach(walk); } else files++;
  };
  tops.forEach(walk);
  return { files, folders };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a multi-selection in the disk browser can do (A5): one .zip of it, or
 * one move or delete of all of it -- each a single commit, so the toast's Undo
 * puts the whole action back. `tops` is the selection with anything inside a
 * selected folder left out (the folder brings it along); `blocks` is what the
 * routes receive, the same rule applied again server-side.
 */
export function SelectionBar({ diskId, tops, directoryOptions, hidden, onClear }: {
  diskId: string;
  tops: AdfEntry[];
  directoryOptions: DirectoryOption[];
  /** Selected items the filter or Hide .info keeps off screen: said, so a Delete never surprises. */
  hidden: number;
  onClear: () => void;
}) {
  const { disabled, busy, runEdit } = useFileEdit();
  const [mode, setMode] = useState<'idle' | 'move' | 'delete'>('idle');
  const [target, setTarget] = useState<number | ''>('');
  // Cancel removes itself with its step: focus goes back to the Move to… or Delete that opened it, never <body>.
  const returnTo = useRef<'move' | 'delete' | null>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode !== 'idle' || !returnTo.current) return;
    (returnTo.current === 'move' ? moveRef : deleteRef).current?.focus();
    returnTo.current = null;
  }, [mode]);
  function cancel() { returnTo.current = mode === 'idle' ? null : mode; setMode('idle'); }
  const blocks = tops.map((e) => e.block);
  const historical = disabled?.reason === 'historical';

  // A folder can never be moved into itself or anything inside it.
  const forbidden = new Set<number>();
  const mark = (e: AdfEntry) => { forbidden.add(e.block); e.children.forEach(mark); };
  tops.filter((e) => e.kind === 'dir').forEach(mark);
  const moveOptions = directoryOptions.filter((o) => !forbidden.has(o.block));

  const { files, folders } = countAll(tops);
  const what = [files ? plural(files, 'file') : '', folders ? plural(folders, 'folder') : ''].filter(Boolean).join(' and ');

  function done() { setMode('idle'); setTarget(''); onClear(); document.getElementById('files-heading')?.focus(); }

  function submitMove() {
    if (target === '') return;
    runEdit(() => fetch(`/api/disks/${diskId}/files/bulk`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'move', blocks, toParent: target }),
    }), `Moved ${plural(tops.length, 'item')}`, done, { undoable: true });
  }

  function submitDelete() {
    runEdit(() => fetch(`/api/disks/${diskId}/files/bulk`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'delete', blocks }),
    }), `Deleted ${plural(tops.length, 'item')}`, done, { undoable: true });
  }

  const button = 'grid h-[30px] shrink-0 place-items-center rounded-[7px] px-2.5 text-[13px] font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--surface)';
  const plain = { background: 'var(--on-ink-fill)', color: 'var(--surface)' };
  const danger = { background: 'var(--danger-fg)', color: '#fff' };

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px]"
         style={{ background: 'var(--ink)', color: 'var(--surface)' }}
         data-testid="fs-selection-bar" role="region" aria-label="Selected files">
      <span className="flex-1 font-semibold" data-testid="fs-selection-count">{plural(tops.length, 'item')} selected</span>
      {hidden > 0 && (
        <span className="text-[12px] font-semibold" style={{ color: 'var(--fetch-dot)' }} data-testid="fs-selection-hidden">
          ({hidden} not shown)
        </span>
      )}

      {mode === 'idle' && (
        <>
          {/* A real link, like a single file's Download: the browser saves the .zip with its own progress.
              Withdrawn on an older version for the same reason (the route reads the current disk). */}
          {historical ? (
            <span className={`${button} opacity-50`} style={plain} aria-disabled="true" title={disabled?.message}
                  data-testid="fs-bulk-download">Download .zip</span>
          ) : (
            <a href={`/api/disks/${diskId}/files/zip?blocks=${blocks.join(',')}`} className={button} style={plain}
               data-testid="fs-bulk-download">Download .zip</a>
          )}
          <button type="button" ref={moveRef} className={button} style={plain} disabled={!!disabled || busy} title={disabled?.message}
                  onClick={() => setMode('move')} data-testid="fs-bulk-move">Move to…</button>
          <button type="button" ref={deleteRef} className={button} style={danger} disabled={!!disabled || busy} title={disabled?.message}
                  onClick={() => setMode('delete')} data-testid="fs-bulk-delete">Delete</button>
          <button type="button" className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[7px] text-[18px] leading-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--surface)"
                  style={plain} aria-label="Clear selection"
                  onClick={() => { onClear(); document.getElementById('files-heading')?.focus(); }}
                  data-testid="fs-selection-clear"><span aria-hidden>×</span></button>
        </>
      )}

      {mode === 'move' && (
        <>
          <select value={target} autoFocus aria-label="Move the selected items to"
                  onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))}
                  className="h-[30px] rounded-[7px] px-2 text-[13px]"
                  style={{ background: 'var(--surface)', color: 'var(--ink)' }} data-testid="fs-bulk-move-target">
            <option value="">Choose a location…</option>
            {moveOptions.map((o) => <option key={o.block} value={o.block}>{o.label}</option>)}
          </select>
          <button type="button" className={button} style={{ background: 'var(--surface)', color: 'var(--ink)' }}
                  disabled={busy || target === ''} onClick={submitMove} data-testid="fs-bulk-move-submit">Move</button>
          <button type="button" className={button} style={plain} disabled={busy}
                  onClick={cancel}>Cancel</button>
        </>
      )}

      {mode === 'delete' && (
        <>
          <span data-testid="fs-bulk-delete-summary">
            Delete {what}?
          </span>
          <button type="button" className={button} style={danger}
                  disabled={busy} onClick={submitDelete} data-testid="fs-bulk-delete-confirm">Delete</button>
          <button type="button" className={button} style={plain} disabled={busy}
                  onClick={cancel}>Cancel</button>
        </>
      )}
    </div>
  );
}
