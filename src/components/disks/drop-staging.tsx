'use client';

import { useMemo, useState } from 'react';
import { readDroppedItems, type DroppedItem } from '@/lib/drop-reader';
import { stageDrop, type StagedEntry } from '@/lib/staging';
import { blocksForPlan, type Filesystem } from '@/lib/adffs';
// The identical fold `stageDrop` itself uses (see staging.ts's own comment):
// reused here, not reinvented, so a live re-check of a typed rename can
// never disagree with the one-shot check `stageDrop` already ran.
import { sameName } from '@/lib/adffs/write';
import { useFileEdit, MAX_NAME_LENGTH } from './file-actions';

/** Split a dropped path into its parent directory key and its own name -- the identical rule `staging.ts` uses internally, needed again here to walk a renamed ancestor chain when building the disk path a batch actually writes to (see `diskPathFor` below). */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { dir: '', name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** How a person has resolved a collision row, or null while it is still outstanding. `'replace'` only ever applies to a `kind: 'file'` row colliding with an existing entry -- there is no such thing as replacing a directory (the batch route's `replace` op is `replaceFile`), so the control for it is never even offered otherwise. */
type Resolution = 'skip' | 'replace' | null;

/** One row's live, derived state -- distinct from `StagedEntry` because a person can retype the name or pick skip/replace, and the collision verdict has to be re-checked against those live values rather than frozen at drop time (otherwise "rename" would never actually clear the block on commit). */
interface LiveRow {
  entry: StagedEntry;
  /** The name that will actually be written: `stageDrop`'s shortened suggestion, unless overridden. */
  name: string;
  resolution: Resolution;
  collidesWith: StagedEntry['collidesWith'];
  /** The exact existing or sibling name this row collides with, for display -- may differ in case from `name` itself (that's the whole reason two names can collide here). */
  conflictName: string | null;
}

export function DropStaging({
  filesystem, intl, existingNamesByDir, freeBlocks,
}: {
  filesystem: Filesystem;
  intl: boolean;
  /** Every directory already on the disk, keyed by its root-relative path ('' for the root itself), to the names it already holds. Plain object rather than a `Map` -- this crosses the server/client boundary from `page.tsx`. */
  existingNamesByDir: Record<string, string[]>;
  freeBlocks: number;
}) {
  const { diskId, disabled, busy, runEdit } = useFileEdit();

  // Everything read from drops so far, across possibly several drops --
  // several drops are meant to land in the SAME staging batch and commit
  // together, so a later drop appends rather than replacing.
  const [dropped, setDropped] = useState<DroppedItem[]>([]);
  const [nameOverrides, setNameOverrides] = useState<ReadonlyMap<string, string>>(new Map());
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, Resolution>>(new Map());
  const [dragOver, setDragOver] = useState(false);

  const existingMap = useMemo(
    () => new Map(Object.entries(existingNamesByDir)),
    [existingNamesByDir],
  );

  // The one-shot verdict from Task 3's own module -- the default name and
  // shortened flag for every row come from here and never change; only the
  // COLLISION verdict is re-derived below, live, because a typed rename or a
  // skip has to be able to actually clear it.
  const baseline = useMemo(
    () => stageDrop(dropped, existingMap, intl),
    [dropped, existingMap, intl],
  );

  const byPath = useMemo(() => new Map(baseline.map((e) => [e.path, e])), [baseline]);
  // `StagedEntry` (staging.ts) carries no File -- only the raw `DroppedItem`
  // does -- so the actual bytes for a commit are looked up here, by path,
  // rather than added to that module's own type.
  const droppedByPath = useMemo(() => new Map(dropped.map((d) => [d.path, d])), [dropped]);

  function effectiveNameFor(path: string): string {
    return nameOverrides.get(path) ?? byPath.get(path)?.name ?? path;
  }

  // Reproduces `stageDrop`'s own grouped, first-occurrence-wins scan, but
  // against the CURRENT name (after any edit) and skipping any row a person
  // has resolved with "skip" -- a skipped row will never be written, so it
  // must not go on blocking, or count as a taken name for, its siblings.
  // NOTE (known, deferred limit): two literally identical dropped paths --
  // e.g. the same folder dropped twice -- alias in `byPath`'s Map; not a
  // real scenario a file picker or a real folder drop can produce.
  const rows: LiveRow[] = useMemo(() => {
    const takenByDir = new Map<string, string[]>();
    return baseline.map((entry): LiveRow => {
      const name = effectiveNameFor(entry.path);
      const resolution = resolutions.get(entry.path) ?? null;
      const { dir } = splitPath(entry.path);

      if (resolution === 'skip') {
        return { entry, name, resolution, collidesWith: null, conflictName: null };
      }

      const existingNames = existingMap.get(dir) ?? [];
      const takenSoFar = takenByDir.get(dir) ?? [];

      let collidesWith: StagedEntry['collidesWith'] = null;
      let conflictName: string | null = null;
      const existingHit = existingNames.find((o) => sameName(o, name, intl));
      if (existingHit !== undefined) {
        collidesWith = 'existing';
        conflictName = existingHit;
      } else {
        const stagedHit = takenSoFar.find((o) => sameName(o, name, intl));
        if (stagedHit !== undefined) {
          collidesWith = 'staged';
          conflictName = stagedHit;
        }
      }

      takenSoFar.push(name);
      takenByDir.set(dir, takenSoFar);

      // 'replace' only resolves an 'existing' collision -- it is never
      // offered for a 'staged' one (see the render below), so a stale
      // 'replace' resolution left over from before a rename is simply
      // ignored rather than trusted, the same way 'skip' is trusted above.
      return {
        entry, name,
        resolution: collidesWith === 'existing' ? resolution : null,
        collidesWith, conflictName,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveNameFor is a plain function (not memoized) closing over byPath and nameOverrides; byPath itself is a useMemo keyed on `baseline`, which IS listed below, so this recomputes exactly when either input actually changes.
  }, [baseline, resolutions, nameOverrides, existingMap, intl]);

  function setName(path: string, name: string) {
    setNameOverrides((prev) => new Map(prev).set(path, name.slice(0, MAX_NAME_LENGTH)));
    // A retyped name is a fresh attempt at fitting in, not a repeat of
    // whatever was already decided -- clear any earlier skip/replace so the
    // live re-check above is what actually governs this row.
    setResolutions((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }

  function setResolution(path: string, resolution: Resolution) {
    setResolutions((prev) => new Map(prev).set(path, resolution));
  }

  function clearResolution(path: string) {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }

  function clearStaged() {
    setDropped([]);
    setNameOverrides(new Map());
    setResolutions(new Map());
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    // CROSS-TASK REQUIREMENT (owed by Task 7, honoured here): this call
    // MUST be the first thing that happens after the native drop event --
    // no `await` anywhere above it in this function. webkitGetAsEntry(),
    // which readDroppedItems calls synchronously before it ever yields,
    // only works inside the live drop handler; the browser neuters
    // `event.dataTransfer` the instant this function returns control (i.e.
    // the moment it would hit its own first `await`). Reading `.items` here
    // -- as a plain function call, not behind an `await` of anything else
    // first -- is what keeps this correct. Get this wrong and a dropped
    // folder arrives as nothing, silently: no vitest suite can catch it.
    readDroppedItems(e.dataTransfer.items).then((items) => {
      setDropped((prev) => [...prev, ...items]);
    });
  }

  const nonSkipped = rows.filter((r) => r.resolution !== 'skip');
  const totalBlocks = useMemo(
    () => blocksForPlan(nonSkipped.map((r) => ({ kind: r.entry.kind, sizeBytes: r.entry.sizeBytes })), filesystem),
    [nonSkipped, filesystem],
  );
  const overCapacity = totalBlocks > freeBlocks;
  // A 'replace' resolution deliberately KEEPS collidesWith === 'existing'
  // (see the rows computation above) -- it is the chosen outcome, not an
  // unresolved one, so only a collision with no resolution yet blocks the
  // commit (D-DD-4).
  const hasOutstandingCollision = rows.some((r) => r.collidesWith !== null && r.resolution === null);
  const commitDisabled = !!disabled || busy || rows.length === 0
    || nonSkipped.length === 0 || hasOutstandingCollision || overCapacity;

  function diskPathFor(path: string): string {
    const { dir } = splitPath(path);
    const leaf = effectiveNameFor(path);
    return dir === '' ? leaf : `${diskPathFor(dir)}/${leaf}`;
  }

  function commit() {
    if (commitDisabled) return;
    const manifest: { op: 'mkdir' | 'add' | 'replace'; path: string }[] = [];
    const form = new FormData();
    for (const row of nonSkipped) {
      const diskPath = diskPathFor(row.entry.path);
      if (row.entry.kind === 'dir') {
        manifest.push({ op: 'mkdir', path: diskPath });
      } else {
        manifest.push({ op: row.resolution === 'replace' ? 'replace' : 'add', path: diskPath });
        // Present on every DroppedItem of kind 'file' (drop-reader.ts);
        // the `!`s reflect that invariant, not a hopeful cast.
        form.set(diskPath, droppedByPath.get(row.entry.path)!.file!);
      }
    }
    form.set('manifest', JSON.stringify(manifest));
    runEdit(
      () => fetch(`/api/disks/${diskId}/files/batch`, { method: 'POST', body: form }),
      `Added ${manifest.length} item${manifest.length === 1 ? '' : 's'}`,
    );
    // Cleared immediately, win or lose -- the same tradeoff FileToolbar's
    // own submitUpload/submitFolder already make (they call cancelUpload /
    // cancelFolder right after firing runEdit): the toast reports failure,
    // router.refresh() reflects success, and a failed commit means
    // re-dropping rather than retrying stale rows against a disk whose
    // state runEdit hasn't yet told this component about.
    clearStaged();
  }

  return (
    <div className="glass-card flex flex-col gap-3 p-4" data-testid="drop-staging">
      {disabled && (
        <p className="text-[12.5px] font-semibold" style={{ color: 'var(--amber-text)' }}
           data-testid="drop-disabled">
          {disabled.message}
        </p>
      )}

      {/*
        Always visible, per the design doc: this is what advertises that the
        page accepts a drop at all, whether or not anything has been
        dropped yet, and it stays the actual drop target once the list
        below is showing too.
      */}
      <div
        onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        data-testid="drop-strip"
        aria-disabled={!!disabled}
        className="rounded-lg border-2 border-dashed px-4 py-3 text-center text-[12.5px] transition-colors"
        style={{
          borderColor: dragOver ? 'var(--primary-action)' : 'var(--hairline)',
          color: 'var(--muted)',
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
      >
        {rows.length === 0
          ? 'Drag files or a folder here to add them to this disk.'
          : `${rows.length} item${rows.length === 1 ? '' : 's'} staged below — drop more to add to the same batch.`}
      </div>

      {rows.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="drop-staging-list">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px]"
               style={{ color: 'var(--muted-2)' }}>
            {/*
              Root only, always -- Task 8 has no mechanism to land a drop on
              a folder row (that is dnd-kit's shared drag context, Task 9).
              Shown as a fact rather than a control until that exists.
            */}
            <span data-testid="drop-destination">Destination: disk root (/)</span>
            <span>
              <span data-testid="drop-total-blocks">{totalBlocks.toLocaleString()}</span>
              {' '}block{totalBlocks === 1 ? '' : 's'} needed ·{' '}
              <span data-testid="drop-free-blocks">{freeBlocks.toLocaleString()}</span> free
            </span>
          </div>

          {overCapacity && (
            <p className="text-[12px] font-semibold" style={{ color: 'var(--danger-fg)' }}
               data-testid="drop-capacity-warning">
              This needs {totalBlocks.toLocaleString()} blocks, but only {freeBlocks.toLocaleString()} are
              free — nothing will be written until it fits.
            </p>
          )}

          <div className="flex flex-col gap-2 divide-y" style={{ borderColor: 'var(--hairline)' }}>
            {rows.map((row, i) => {
              const resolved = row.resolution !== null;
              // Still an open collision needing a decision -- once resolved
              // (skip or replace), the conflict/skip/replace controls give
              // way to a resolution line and Undo instead (below).
              const openCollision = row.collidesWith !== null && !resolved;
              // Editable whenever the name isn't just going to sit there as
              // typed: an open collision (rename is one of its three
              // resolutions) or a plain over-length shortening. A 'replace'
              // or 'skip' resolution locks the name back down -- Undo is
              // the way back to editing it.
              const editable = openCollision || (row.entry.shortened && !resolved);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 pt-2 text-[12px]"
                     data-testid={`stage-row-${i}`}>
                  <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--muted-2)' }}
                        title={row.entry.path}>
                    {row.entry.kind === 'dir' ? '📁 ' : ''}{row.entry.path}
                  </span>

                  {editable ? (
                    <input
                      value={row.name}
                      onChange={(e) => setName(row.entry.path, e.target.value)}
                      maxLength={MAX_NAME_LENGTH}
                      aria-label={`Name to write "${row.entry.path}" under`}
                      data-testid={`stage-name-${i}`}
                      className="rounded border bg-transparent px-2 py-0.5 text-[11.5px]"
                      style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}
                    />
                  ) : (
                    <span data-testid={`stage-name-${i}`} style={{ color: 'var(--ink)' }}>
                      {row.name}
                    </span>
                  )}

                  {openCollision && (
                    <>
                      <span data-testid={`stage-conflict-${i}`} className="font-semibold"
                            style={{ color: 'var(--danger-fg)' }}>
                        collides with {row.collidesWith === 'existing' ? 'existing' : 'another staged'}
                        {' '}&quot;{row.conflictName}&quot;
                      </span>
                      <button type="button" onClick={() => setResolution(row.entry.path, 'skip')}
                              data-testid={`stage-skip-${i}`}
                              className="rounded px-2 py-0.5 text-[11px] font-semibold"
                              style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
                        Skip
                      </button>
                      {row.entry.kind === 'file' && row.collidesWith === 'existing' && (
                        <button type="button" onClick={() => setResolution(row.entry.path, 'replace')}
                                data-testid={`stage-replace-${i}`}
                                className="rounded px-2 py-0.5 text-[11px] font-semibold text-white"
                                style={{ background: 'var(--primary-action)' }}>
                          Replace
                        </button>
                      )}
                    </>
                  )}

                  {resolved && (
                    <>
                      <span data-testid={`stage-resolution-${i}`} className="text-[11px] font-semibold"
                            style={{ color: 'var(--muted)' }}>
                        {row.resolution === 'skip' ? 'Skipped' : 'Will replace existing'}
                      </span>
                      <button type="button" onClick={() => clearResolution(row.entry.path)}
                              data-testid={`stage-undo-${i}`}
                              className="text-[11px] underline-offset-2 hover:underline"
                              style={{ color: 'var(--muted)' }}>
                        Undo
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={commit}
              disabled={commitDisabled}
              data-testid="drop-commit"
              className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--primary-action)' }}
            >
              {busy ? 'Writing…' : `Add ${nonSkipped.length} item${nonSkipped.length === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              onClick={clearStaged}
              disabled={busy}
              data-testid="drop-clear"
              className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
              style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
