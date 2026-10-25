'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { readDroppedItems, type DroppedItem } from '@/lib/drop-reader';
import { expandArchivesInDrop, stagingSummary, type ArchiveNotice } from '@/lib/archive-drop';
import { toast } from 'sonner';
import {
  stageDrop, joinDestination, existingCollisionAt, pathTooDeep, rowNameProblem, type StagedEntry, type ExistingEntry,
} from '@/lib/staging';
import { useNativeDrop } from './native-drop';
import { blocksForPlan, type AdfEntry, type Filesystem } from '@/lib/adffs';
// The identical fold `stageDrop` itself uses (see staging.ts's own comment):
// reused here, not reinvented, so a live re-check of a typed rename can
// never disagree with the one-shot check `stageDrop` already ran.
import { sameName } from '@/lib/adffs/write';
// The SAME directory-collecting walk the "Move to…" menu already uses
// (fix: the spec calls for every folder to be a usable destination, and a
// second, independently-written walk here could quietly disagree with that
// one about what counts as a directory or how it's labelled).
import { collectDirectories, type DirectoryOption } from './file-tree';
import { useFileEdit, MAX_NAME_LENGTH } from './file-actions';
import { formatKb } from '@/lib/disk-files-look';

/** Split a dropped path into its parent directory key and its own name -- the identical rule `staging.ts` uses internally, needed again here to walk a renamed ancestor chain when building the disk path a batch actually writes to (see `diskPathFor` below). */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { dir: '', name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** How a person has resolved a collision row, or null while it is still outstanding. `'replace'` only ever applies to a `kind: 'file'` row colliding with an existing entry that is ITSELF a file -- there is no such thing as replacing a directory (the batch route's `replace` op is `replaceFile`, which requires `ST_FILE`), so the control for it is never even offered otherwise (fix round 1, Finding 2). */
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
  /**
   * The KIND of the existing entry this row collides with, only when
   * `collidesWith === 'existing'` -- null otherwise. Fix round 1, Finding
   * 2: "replace" (`replaceFile`) only makes sense against an existing
   * FILE, so a dropped file colliding with an existing DIRECTORY must
   * never be offered it, even though `row.entry.kind === 'file'` alone
   * would wrongly suggest it could be.
   */
  existingKind: 'file' | 'dir' | null;
}

export function DropStaging({
  filesystem, intl, existingNamesByDir, freeBlocks, entries, freeBytes, volumeName,
}: {
  filesystem: Filesystem;
  intl: boolean;
  /**
   * Every directory already on the disk, keyed by its root-relative path
   * ('' for the root itself), to the entries it already holds -- name AND
   * kind (fix round 1, Finding 2: a name-only map can't tell a same-named
   * file from a same-named directory apart, and that distinction is what
   * decides whether "replace" is even sound). Plain object rather than a
   * `Map` -- this crosses the server/client boundary from `page.tsx`.
   */
  existingNamesByDir: Record<string, ExistingEntry[]>;
  freeBlocks: number;
  /**
   * The disk's own tree, root's children only -- feeds the destination
   * selector's directory list (`collectDirectories`, the same helper
   * `FileTree`'s "Move to…" menu already uses). Not derived from
   * `existingNamesByDir`, which has no block numbers and so can't back a
   * `<select>` needing a stable value per option.
   */
  entries: AdfEntry[];
  /** The disk's free bytes for the bar's second line, or null when the usage could not be read. */
  freeBytes: number | null;
  /** The volume's name, shown in the bar's mono run. */
  volumeName: string;
}) {
  const { diskId, disabled, busy, runEdit, rootBlock } = useFileEdit();

  // Everything read from drops so far, across possibly several drops --
  // several drops are meant to land in the SAME staging batch and commit
  // together, so a later drop appends rather than replacing.
  const [dropped, setDropped] = useState<DroppedItem[]>([]);
  /**
   * Rows the person has decided not to take at all.
   *
   * Separate from `resolutions`, deliberately. A 'skip' there means "this
   * collides and I choose not to overwrite", and the resolution line and the
   * folder-merge wording both read it that way. Dropping an ARCHIVE is the
   * case the operator described as "pick a few files out of", which is a
   * different statement about a row that may not collide with anything --
   * overloading 'skip' would make a plain exclusion claim a collision was
   * resolved.
   */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [nameOverrides, setNameOverrides] = useState<ReadonlyMap<string, string>>(new Map());
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, Resolution>>(new Map());
  const [dragOver, setDragOver] = useState(false);
  /** Archive members that will NOT be written (unreadable, unsafe path, too deep, duplicate) -- kept on screen with the batch rather than only in a toast, because "what will be written" includes what will not. */
  const [archiveSkipped, setArchiveSkipped] = useState<ArchiveNotice[]>([]);
  const cardRef = useRef<HTMLDivElement>(null);
  /** Why the last drop on a Browse folder was refused (it aimed at a folder other than the staged batch's), or null. */
  const [refusedDrop, setRefusedDrop] = useState<string | null>(null);

  const existingMap = useMemo(
    () => new Map(Object.entries(existingNamesByDir)),
    [existingNamesByDir],
  );

  // Every folder ROW is a drop target per the design doc -- but a native OS
  // drop cannot actually be landed on one (see this control's own comment
  // in the render below, and HANDOFF.md §3v: the deviation is recorded
  // there, not hidden). This selector is what stands in for it: root plus
  // every directory already on the disk, defaulting to root, using the
  // IDENTICAL walk (`collectDirectories`) the "Move to…" menu already
  // built rather than a second one that could disagree with it.
  const directoryOptions = useMemo<DirectoryOption[]>(
    () => [{ block: rootBlock, label: '/' }, ...collectDirectories(entries)],
    [entries, rootBlock],
  );
  const [destinationBlock, setDestinationBlock] = useState<number>(rootBlock);
  /**
   * The ONLY way the destination changes. Every skip/replace and typed rename
   * was decided against the folder chosen at the time -- a "replace" for
   * /A/X is not a decision about /B/X -- so they all go when it changes, and
   * the live collision check asks again for the new folder.
   */
  function changeDestination(block: number) {
    if (block === destinationBlock) return;
    setDestinationBlock(block);
    setResolutions(new Map());
    setNameOverrides(new Map());
    setRefusedDrop(null);
  }
  // `collectDirectories`' labels are slash-prefixed ("/Docs", "/Docs/Sub")
  // for display; the internal convention every path in this component (and
  // `existingNamesByDir`'s own keys) uses is un-prefixed, '' for the root
  // itself -- so this strips exactly one leading slash rather than
  // reinventing a second path format.
  const destinationPath = useMemo(() => {
    const label = directoryOptions.find((d) => d.block === destinationBlock)?.label ?? '/';
    return label === '/' ? '' : label.slice(1);
  }, [directoryOptions, destinationBlock]);
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
      // Joined onto the CHOSEN destination, not the disk root: a row's own
      // `dir` is only its position WITHIN the dropped tree (e.g. '' for
      // something dropped directly, "Sub" for something nested one level
      // in) -- where it actually lands on the disk is that, prefixed by
      // wherever the destination selector points. `joinDestination` is the
      // SAME function `diskPathFor` below uses to build the written path,
      // so the two can never disagree about which directory this is.
      const dir = joinDestination(destinationPath, splitPath(entry.path).dir);
      const takenSoFar = takenByDir.get(dir) ?? [];

      let collidesWith: StagedEntry['collidesWith'] = null;
      let conflictName: string | null = null;
      let existingKind: 'file' | 'dir' | null = null;
      // An 'existing' collision is a fact about the disk itself, so it is
      // checked regardless of resolution -- what changes below is only
      // whether a 'staged' collision (competition between two DROPPED
      // items) still counts once one of them has been skipped out of it.
      // `existingCollisionAt` re-derives the SAME `dir` internally via
      // `joinDestination` -- passed the un-joined `splitPath(...).dir` and
      // `destinationPath` separately here would risk joining it twice, so
      // the raw (pre-join) directory is what actually gets passed to it,
      // via `existingHit` below.
      const existingHit = existingCollisionAt(
        name, splitPath(entry.path).dir, destinationPath, existingMap, intl,
      );
      if (existingHit !== null) {
        collidesWith = 'existing';
        conflictName = existingHit.name;
        existingKind = existingHit.kind;
      } else if (resolution !== 'skip') {
        const stagedHit = takenSoFar.find((o) => sameName(o, name, intl));
        if (stagedHit !== undefined) {
          collidesWith = 'staged';
          conflictName = stagedHit;
        }
      }

      // A skipped row will never be written, so it must not go on
      // occupying a name slot its siblings are also competing for.
      if (resolution !== 'skip') {
        takenSoFar.push(name);
        takenByDir.set(dir, takenSoFar);
      }

      if (resolution === 'skip') {
        // `existingKind` is kept (not nulled) even though this row is
        // resolved -- it is what lets the resolved line below tell a
        // skipped FOLDER MERGE ("existingKind === 'dir'") apart from a
        // skipped anything-else, per fix round 1, Finding 1.
        return {
          entry, name, resolution, collidesWith: null, conflictName: null, existingKind,
        };
      }

      // 'replace' only resolves an 'existing' collision AGAINST A FILE --
      // it is never offered against an existing directory (there is no
      // such op as replacing a directory) or a 'staged' one (see the
      // render below), so a stale 'replace' resolution left over from
      // before a rename, or one that no longer applies now that the
      // collision is against a directory, is simply ignored rather than
      // trusted.
      return {
        entry, name,
        resolution: collidesWith === 'existing' && existingKind === 'file' ? resolution : null,
        collidesWith, conflictName, existingKind,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveNameFor is a plain function (not memoized) closing over byPath and nameOverrides; byPath itself is a useMemo keyed on `baseline`, which IS listed below, so this recomputes exactly when either input actually changes. `joinDestination`/`existingCollisionAt` are imported, pure functions, not component state.
  }, [baseline, resolutions, nameOverrides, existingMap, intl, destinationPath]);

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
    setExcluded(new Set());
    setArchiveSkipped([]);
    setRefusedDrop(null);
  }

  /**
   * Read a native drop and stage it. MUST be called synchronously from the
   * drop handler itself -- see the comment inside. `destinationBlock` is the
   * Browse folder the drop landed on, when it landed on one rather than on
   * the strip.
   */
  function ingest(items: DataTransferItemList, destination: number | null) {
    // A staged batch has ONE destination. A drop aimed at a different folder
    // does not move it (that would retarget rows already reviewed for the
    // first folder) and is not quietly staged for the wrong one either: it is
    // refused, and nothing from it is read. Same folder, or the strip (which
    // means "the batch's destination"), adds as before.
    if (destination !== null && dropped.length > 0 && destination !== destinationBlock) {
      const label = directoryOptions.find((d) => d.block === destinationBlock)?.label ?? '/';
      const message = `This batch goes to ${label}. Write or clear it first, or change the destination above.`;
      setRefusedDrop(message);
      toast.error('Not added to this batch', { description: message });
      return;
    }
    // CROSS-TASK REQUIREMENT (owed by Task 7, honoured here): this call
    // MUST be the first thing that happens after the native drop event --
    // no `await` anywhere above it. webkitGetAsEntry(), which
    // readDroppedItems calls synchronously before it ever yields, only works
    // inside the live drop handler; the browser neuters `dataTransfer` the
    // instant the handler returns control. Get this wrong and a dropped
    // folder arrives as nothing, silently: no vitest suite can catch it.
    readDroppedItems(items).then(async (read) => {
      // Archives expand HERE, after the synchronous read above, into exactly
      // the DroppedItem shape a folder produces (archive-drop.ts) -- which is
      // what lets staging, the destination, collision handling and the
      // free-space estimate apply to an .lha/.lzh without knowing it is one.
      const { items: out, refused, skipped } = await expandArchivesInDrop(read);
      for (const r of refused) {
        toast.error('Could not read that archive', { description: r.message });
      }
      // Only reached with an empty batch or the batch's own folder (above).
      if (destination !== null && out.length > 0) changeDestination(destination);
      if (out.length > 0) {
        setRefusedDrop(null);
        setDropped((prev) => [...prev, ...out]);
        // A drop on a tree row lands above this card; bring the review into view.
        if (destination !== null) cardRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      }
      if (skipped.length > 0) setArchiveSkipped((prev) => [...prev, ...skipped]);
    });
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    ingest(e.dataTransfer.items, null);
  }

  // The Browse tree forwards drops on its rows here (native-drop.tsx). The
  // receiver is re-registered every render so it never closes over stale
  // state; it is a ref write, not a re-render.
  const nativeDrop = useNativeDrop();
  useEffect(() => {
    if (!nativeDrop) return;
    nativeDrop.register((items, block) => {
      if (disabled) { toast.error(disabled.message); return; }
      ingest(items, block);
    });
    return () => nativeDrop.register(null);
  });

  const nonSkipped = rows.filter((r) => r.resolution !== 'skip' && !excluded.has(r.entry.path));
  const totalBlocks = useMemo(
    () => blocksForPlan(nonSkipped.map((r) => ({ kind: r.entry.kind, sizeBytes: r.entry.sizeBytes })), filesystem),
    [nonSkipped, filesystem],
  );
  const overCapacity = totalBlocks > freeBlocks;
  const summary = stagingSummary(nonSkipped.map((r) => r.entry));
  // Deeper than readVolume walks once joined onto the destination -- the batch
  // route refuses the same paths (pathTooDeep is shared), this says so first.
  const tooDeep = nonSkipped.filter((r) => pathTooDeep(diskPathFor(r.entry.path)));
  // A typed rename is the one name nothing has sanitised (rowNameProblem).
  const badName = nonSkipped.some((r) => rowNameProblem(r.name) !== null);
  // A 'replace' resolution deliberately KEEPS collidesWith === 'existing'
  // (see the rows computation above) -- it is the chosen outcome, not an
  // unresolved one, so only a collision with no resolution yet blocks the
  // commit (D-DD-4).
  const hasOutstandingCollision = rows.some((r) => r.collidesWith !== null && r.resolution === null);
  const commitDisabled = !!disabled || busy || rows.length === 0
    || nonSkipped.length === 0 || hasOutstandingCollision || overCapacity || tooDeep.length > 0 || badName;

  /** The path this dropped item would sit at from the drop's OWN root -- recurses through renamed ancestors, but knows nothing of the destination selector; see `diskPathFor` below for the path actually written. */
  function relativePathFor(path: string): string {
    const { dir } = splitPath(path);
    const leaf = effectiveNameFor(path);
    return dir === '' ? leaf : `${relativePathFor(dir)}/${leaf}`;
  }

  /**
   * The path actually written on commit: `joinDestination` (the SAME join
   * the live collision recheck above uses) applied exactly ONCE, ahead of
   * the drop-relative path -- never per level of `relativePathFor`'s own
   * recursion, which would otherwise repeat it once per ancestor.
   */
  function diskPathFor(path: string): string {
    return joinDestination(destinationPath, relativePathFor(path));
  }

  function commit() {
    if (commitDisabled) return;
    const manifest: { op: 'mkdir' | 'add' | 'replace'; path: string; protection?: number }[] = [];
    const form = new FormData();
    for (const row of nonSkipped) {
      const diskPath = diskPathFor(row.entry.path);
      if (row.entry.kind === 'dir') {
        manifest.push({ op: 'mkdir', path: diskPath });
      } else {
        // Protection rides on the manifest rather than through staging.ts:
        // the dropped item is already looked up here for its bytes, and
        // StagedEntry has no business carrying an Amiga permission word.
        // Undefined when the archive said nothing, which the writer turns
        // into the AmigaDOS default rather than inventing bits.
        const prot = droppedByPath.get(row.entry.path)?.protection;
        manifest.push({
          op: row.resolution === 'replace' ? 'replace' : 'add',
          path: diskPath,
          ...(typeof prot === 'number' ? { protection: prot } : {}),
        });
        // Present on every DroppedItem of kind 'file' (drop-reader.ts);
        // the `!`s reflect that invariant, not a hopeful cast.
        form.set(diskPath, droppedByPath.get(row.entry.path)!.file!);
      }
    }
    form.set('manifest', JSON.stringify(manifest));
    // Cleared ONLY on success (`onSuccess`, third arg) -- unlike
    // FileToolbar's own submitUpload/submitFolder, which clear regardless
    // because their forms hold one filename each. A staged batch here can
    // be a reviewed folder tree with collisions worked through row by row;
    // throwing all of that away on a disk-full or mounted-device refusal
    // (or on any other 400) would make the person redo the review, not
    // just retry the write, over a failure the toast already explains.
    runEdit(
      () => fetch(`/api/disks/${diskId}/files/batch`, { method: 'POST', body: form }),
      `Added ${manifest.length} item${manifest.length === 1 ? '' : 's'}`,
      // The list and its commit button vanish on success, so focus goes to the Files heading (spec §9).
      () => { clearStaged(); document.getElementById('files-heading')?.focus(); },
      { undoable: true },
    );
  }

  return (
    <section ref={cardRef} aria-label="Add files to this disk" data-testid="drop-staging"
             className="flex flex-col gap-3 rounded-[16px] p-3 pl-4"
             style={{ background: 'var(--surface)',
                      border: rows.length === 0 ? '1.5px dashed var(--dash)' : '1px solid var(--line)' }}>
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
        className="flex min-h-[44px] items-center gap-3.5 rounded-[12px]"
        style={{
          background: dragOver ? 'var(--surface-2)' : undefined,
          outline: dragOver ? '1.5px solid var(--ink)' : undefined,
          opacity: disabled ? 0.6 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
      >
        <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]"
              style={{ background: 'var(--track)', color: 'var(--ink)' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 13v2.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V13" />
          </svg>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {disabled ? (
            <p className="text-[13px] font-semibold" style={{ color: 'var(--amber-text)' }} data-testid="drop-disabled">
              {disabled.message}
            </p>
          ) : rows.length === 0 ? (
            <>
              <span className="text-[14px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
                Drop files, folders or an .lha / .lzh / .zip here or on a folder to add them to{' '}
                <span className="font-mono">{volumeName}</span>
              </span>
              <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
                {freeBytes === null ? 'Free space unknown' : `${formatKb(freeBytes)} free on this disk`} · every change is saved as a new version
              </span>
            </>
          ) : (
            <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
              {rows.length} item{rows.length === 1 ? '' : 's'} staged below — drop more to add to the same batch.
            </span>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="drop-staging-list">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px]"
               style={{ color: 'var(--muted-2)' }}>
            {/*
              A native OS drop cannot actually be landed ON a folder row --
              the browser's drag-and-drop APIs and dnd-kit's own drag
              context are two entirely separate mechanisms with no shared
              event to land one inside the other, and there is no way to
              tell, from inside a native `drop` handler, which rendered row
              the pointer was over. This selector is the deviation the spec
              asked for a plain statement of (HANDOFF.md §3v): every
              directory on the disk IS a usable destination, chosen HERE
              rather than by dropping directly onto its row.
            */}
            <label className="flex items-center gap-1.5">
              Destination:
              <select
                data-testid="drop-destination-select"
                value={destinationBlock}
                onChange={(e) => changeDestination(Number(e.target.value))}
                className="h-[30px] rounded-[8px] border bg-transparent px-1.5 text-[11px]"
                style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
              >
                {directoryOptions.map((opt) => (
                  <option key={opt.block} value={opt.block}>{opt.label}</option>
                ))}
              </select>
            </label>
            <span>
              <span data-testid="drop-total-blocks">{totalBlocks.toLocaleString()}</span>
              {' '}block{totalBlocks === 1 ? '' : 's'} needed ·{' '}
              <span data-testid="drop-free-blocks">{freeBlocks.toLocaleString()}</span> free
            </span>
          </div>

          <p className="text-[12px]" style={{ color: 'var(--ink)' }} data-testid="drop-summary">
            {summary.files} file{summary.files === 1 ? '' : 's'} and {summary.folders} folder{summary.folders === 1 ? '' : 's'}
            {' · '}{summary.bytes.toLocaleString()} byte{summary.bytes === 1 ? '' : 's'}
          </p>

          {refusedDrop && (
            <p className="text-[12px] font-semibold" style={{ color: 'var(--danger-fg)' }}
               data-testid="drop-destination-refused">
              {refusedDrop}
            </p>
          )}

          {archiveSkipped.length > 0 && (
            <div className="text-[11.5px]" style={{ color: 'var(--amber-text)' }} data-testid="drop-archive-skipped">
              <p className="font-semibold">
                {archiveSkipped.length} item{archiveSkipped.length === 1 ? '' : 's'} from the archive will not be written:
              </p>
              <ul className="list-disc pl-5">
                {archiveSkipped.slice(0, 20).map((k, i) => (
                  <li key={i}>{k.archive}: {k.path} ({k.reason})</li>
                ))}
                {archiveSkipped.length > 20 && <li>and {archiveSkipped.length - 20} more</li>}
              </ul>
            </div>
          )}

          {tooDeep.length > 0 && (
            <p className="text-[12px] font-semibold" style={{ color: 'var(--danger-fg)' }}
               data-testid="drop-depth-warning">
              {tooDeep.length} item{tooDeep.length === 1 ? ' is' : 's are'} nested deeper than an Amiga folder
              tree this browser can read back — leave {tooDeep.length === 1 ? 'it' : 'them'} out or pick a shallower destination.
            </p>
          )}

          {overCapacity && (
            <p className="text-[12px] font-semibold" style={{ color: 'var(--danger-fg)' }}
               data-testid="drop-capacity-warning">
              This needs {totalBlocks.toLocaleString()} blocks, but only {freeBlocks.toLocaleString()} are
              free — nothing will be written until it fits.
            </p>
          )}

          <div className="flex flex-col gap-2 divide-y" style={{ borderColor: 'var(--line)' }}>
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
              const isExcluded = excluded.has(row.entry.path);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 pt-2 text-[12px]"
                     data-testid={`stage-row-${i}`} data-excluded={isExcluded ? 'true' : 'false'}
                     style={isExcluded ? { opacity: 0.45 } : undefined}>
                  {/*
                    Take it or leave it, on EVERY row. A dropped folder is
                    normally taken whole, but an archive is "pick a few files
                    out of" -- and the existing skip control only appears on a
                    collision, which most archive members do not have.
                  */}
                  <button type="button"
                          onClick={() => setExcluded((prev) => {
                            const next = new Set(prev);
                            if (!next.delete(row.entry.path)) next.add(row.entry.path);
                            return next;
                          })}
                          data-testid={`stage-include-${i}`}
                          aria-pressed={!isExcluded}
                          title={isExcluded ? 'Not being added — click to include' : 'Will be added — click to leave out'}
                          className="grid h-7 min-w-7 shrink-0 place-items-center rounded-[8px] px-1.5 text-[11px] font-semibold"
                          style={{ border: '1px solid var(--line)',
                                   color: isExcluded ? 'var(--muted)' : 'var(--ink)' }}>
                    {isExcluded ? '☐' : '☑'}
                  </button>
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
                      className="h-[30px] rounded-[8px] border bg-transparent px-2 text-[12px]"
                      style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}
                    />
                  ) : (
                    <span data-testid={`stage-name-${i}`} style={{ color: 'var(--ink)' }}>
                      {row.name}
                    </span>
                  )}

                  {!isExcluded && row.resolution !== 'skip' && rowNameProblem(row.name) && (
                    <span data-testid={`stage-name-error-${i}`} className="font-semibold"
                          style={{ color: 'var(--danger-fg)' }}>
                      {rowNameProblem(row.name)}
                    </span>
                  )}

                  {/*
                    Fix round 1, Finding 1: a directory colliding with an
                    EXISTING DIRECTORY of the same name is not really being
                    "skipped" -- the underlying resolution is still 'skip'
                    (nothing changes about what gets written), but what it
                    actually means is "don't create a second one, add my
                    contents into the one already there" -- a merge, not a
                    no-op. Every other combination (a file colliding either
                    way, or a directory colliding with an existing FILE, or
                    two staged items colliding with each other) keeps the
                    plain "skip" wording, because for those there really is
                    nothing to merge into.
                  */}
                  {openCollision && (() => {
                    const isFolderMerge = row.entry.kind === 'dir' && row.collidesWith === 'existing'
                      && row.existingKind === 'dir';
                    return (
                      <>
                        <span data-testid={`stage-conflict-${i}`} className="font-semibold"
                              style={{ color: 'var(--danger-fg)' }}>
                          {isFolderMerge
                            ? <>a folder named &quot;{row.conflictName}&quot; already exists here</>
                            : <>collides with {row.collidesWith === 'existing' ? 'existing' : 'another staged'}
                              {' '}&quot;{row.conflictName}&quot;</>}
                        </span>
                        <button type="button" onClick={() => setResolution(row.entry.path, 'skip')}
                                data-testid={`stage-skip-${i}`}
                                className="h-7 rounded-[8px] border px-2.5 text-[11px] font-semibold"
                                style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>
                          {isFolderMerge ? 'Use existing folder' : 'Skip'}
                        </button>
                        {row.entry.kind === 'file' && row.collidesWith === 'existing'
                          && row.existingKind === 'file' && (
                          <button type="button" onClick={() => setResolution(row.entry.path, 'replace')}
                                  data-testid={`stage-replace-${i}`}
                                  className="h-7 rounded-[8px] px-2.5 text-[11px] font-semibold text-white"
                                  style={{ background: 'var(--primary-action)' }}>
                            Replace
                          </button>
                        )}
                      </>
                    );
                  })()}

                  {resolved && (() => {
                    const wasFolderMerge = row.resolution === 'skip' && row.entry.kind === 'dir'
                      && row.existingKind === 'dir';
                    return (
                      <>
                        <span data-testid={`stage-resolution-${i}`} className="text-[11px] font-semibold"
                              style={{ color: 'var(--muted)' }}>
                          {row.resolution === 'replace'
                            ? 'Will replace existing'
                            // Wording states the EFFECT, not the mechanism
                            // (fix round 1, Finding 1): "skipped" would tell
                            // the operator nothing was written under this
                            // path, when its contents are in fact merged
                            // into the folder already there.
                            : wasFolderMerge
                              ? 'Not created — its contents are added to the folder already there'
                              : 'Skipped'}
                        </span>
                        <button type="button" onClick={() => clearResolution(row.entry.path)}
                                data-testid={`stage-undo-${i}`}
                                className="h-7 text-[11px] underline-offset-2 hover:underline"
                                style={{ color: 'var(--muted)' }}>
                          Undo
                        </button>
                      </>
                    );
                  })()}
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
              className="h-9 rounded-[10px] px-4 text-[12.5px] font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--primary-action)' }}
            >
              {busy ? 'Writing…' : `Add ${nonSkipped.length} item${nonSkipped.length === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              // Clear vanishes with the list: focus goes to the Files heading, as after a commit (spec §9).
              onClick={() => { clearStaged(); document.getElementById('files-heading')?.focus(); }}
              disabled={busy}
              data-testid="drop-clear"
              className="h-9 rounded-[10px] border px-4 text-[12.5px] font-semibold disabled:opacity-50"
              style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
