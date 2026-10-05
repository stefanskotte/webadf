'use client';

// The "Disk set" section on a title page with two or more disks (disk-sets
// spec, mockup views 1 and 2). At rest it is the existing disk rows under a
// heading, each row gaining a ⋯ menu (Move up / Move down / Move out of set).
// Reorder mode swaps the rows for a compact sortable list: drag by the grip,
// or ▲▼ for a phone or a keyboard. Every move is saved as it happens, so
// "Done" only leaves the mode -- there is nothing to commit.
//
// No data fetching here: the page passes the disks, and every change ends in
// router.refresh() so the server's order is what is drawn afterwards.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, Pencil } from 'lucide-react';
import type { GameDetailDisk } from '@/lib/queries';
import type { MountChoice } from '@/lib/mount-choice';
import type { FobDevice } from '@/components/nfc/fob-button';
import { DiskRow } from './disk-row';
import { AddDisksDialog } from './add-disks-dialog';
import { HelpTip } from '@/components/help/help-tip';

export interface DiskSetEntry {
  disk: GameDetailDisk;
  /** Per-device verdict for THIS disk, computed by the page (lib/mount-choice.ts). */
  choices: MountChoice[];
}

// 44px below `sm` (touch), the mockup's 30px pill from `sm` up.
const BTN_CLASS =
  'btn-like inline-flex h-11 shrink-0 items-center justify-center rounded-full border px-3 text-[12px] font-semibold sm:h-[30px]';
const BTN_STYLE = { borderColor: 'var(--hairline-strong)', background: 'var(--glass-strong)', color: 'var(--ink)' };
const BTN_PRIMARY_STYLE = { borderColor: 'var(--primary-action)', background: 'var(--primary-action)', color: '#fff' };

// The same fallback DiskRow uses, so a disk has one name on this page.
function diskName(d: GameDetailDisk): string {
  return d.tosecName ?? d.sourceFilename ?? `Disk ${d.diskNo}`;
}

export function DiskSetSection({ gameId, title, entries, from, fobDevices = [] }: {
  gameId: string;
  /** The title's name, for the Add disks… heading and its "Moved to" toast. */
  title: string;
  /** The title's disks, in set order, with their mount choices. */
  entries: DiskSetEntry[];
  /** Carried through to each DiskRow (see disk-row.tsx). */
  from?: string;
  fobDevices?: FobDevice[];
}) {
  const router = useRouter();
  const [reordering, setReordering] = useState(false);
  const [adding, setAdding] = useState(false);

  // The order as drawn in reorder mode: optimistic, so the numbers move the
  // moment a row does. Re-seeded whenever the server's order changes (after
  // each refresh), using React's "adjust state while rendering" pattern
  // rather than an effect, so there is never a frame showing the stale order.
  const serverIds = entries.map((e) => e.disk.id);
  const serverKey = serverIds.join(',');
  const [seenKey, setSeenKey] = useState(serverKey);
  const [order, setOrder] = useState<string[]>(serverIds);
  if (seenKey !== serverKey) {
    setSeenKey(serverKey);
    setOrder(serverIds);
  }

  // PUTs go out one at a time, in the order they were made. Two quick ▲
  // presses otherwise race, and the server keeps whichever arrives last --
  // which need not be the order on screen. The refresh waits for the queue to
  // drain: refreshing after each PUT would re-seed `order` from an
  // intermediate server order and make the rows jump back and forth.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);

  function saveOrder(ids: string[]) {
    pending.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        let res: Response;
        try {
          res = await fetch(`/api/games/${gameId}/disk-order`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ diskIds: ids }),
          });
        } catch {
          toast.error('Could not reach the server', { description: 'The new order was not saved.' });
          setOrder(serverIds);
          return;
        }
        if (res.status === 409) {
          // A disk was added, removed or moved elsewhere since this page was
          // drawn. Show the set as it now is rather than guessing.
          toast.error('The set changed — reloaded');
          setOrder(serverIds);
        } else if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast.error('Could not reorder the disks', {
            description: typeof body.error === 'string' ? body.error : undefined,
          });
          setOrder(serverIds);
        }
      } finally {
        pending.current -= 1;
        if (pending.current === 0) router.refresh();
      }
    });
  }

  function move(ids: string[], fromIdx: number, toIdx: number) {
    if (toIdx < 0 || toIdx >= ids.length || fromIdx === toIdx) return;
    const next = arrayMove(ids, fromIdx, toIdx);
    setOrder(next);
    saveOrder(next);
  }

  async function moveOut(diskId: string) {
    let res: Response;
    try {
      res = await fetch(`/api/disks/${diskId}/move-out`, { method: 'POST' });
    } catch {
      toast.error('Could not reach the server', { description: 'The disk was not moved.' });
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error('Could not move the disk out', {
        description: typeof body.error === 'string' ? body.error : undefined,
      });
      router.refresh();
      return;
    }
    const { gameId: newGameId } = (await res.json()) as { gameId: string };
    // Stay on the set (operator, 2026-09-29): the disk leaves the list and the
    // rest renumber on refresh; the new title is one click away in the toast.
    toast.success('Moved out to its own title', {
      action: { label: 'Open', onClick: () => router.push(`/games/${newGameId}`) },
    });
    router.refresh();
  }

  const byId = new Map(entries.map((e) => [e.disk.id, e]));
  const shown = order.filter((id) => byId.has(id));
  const n = entries.length;

  return (
    <section className="flex flex-col gap-3" data-testid="disk-set-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <span className="text-[13px] font-bold" style={{ color: 'var(--ink)' }}>Disk set</span>
          <HelpTip topic="disk-sets" />
          <SetName gameId={gameId} title={title} />
          <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
            {reordering
              ? '· drag to reorder, saved as you go'
              : `· ${n} disks · order = what Next disk steps through`}
          </span>
        </div>
        <div className="flex gap-1.5">
          {reordering ? (
            <button type="button" data-testid="disk-set-done" className={BTN_CLASS}
                    style={BTN_PRIMARY_STYLE} onClick={() => setReordering(false)}>
              Done
            </button>
          ) : (
            <>
              <button type="button" data-testid="disk-set-add" className={BTN_CLASS} style={BTN_STYLE}
                      onClick={() => setAdding(true)}>
                Add disks…
              </button>
              <button type="button" data-testid="disk-set-reorder" className={BTN_CLASS} style={BTN_STYLE}
                      onClick={() => setReordering(true)}>
                Reorder
              </button>
            </>
          )}
        </div>
      </div>

      {adding && (
        <AddDisksDialog mode={{ kind: 'add', gameId, title }} onClose={() => setAdding(false)} />
      )}

      {reordering ? (
        <ReorderList
          order={shown}
          byId={byId}
          onMove={move}
        />
      ) : (
        // Drawn in the optimistic order too, so a Move up is seen at once;
        // the "Disk N" labels catch up when the refresh lands.
        shown.map((id, i) => {
          const { disk, choices } = byId.get(id)!;
          return (
            <DiskRow
              key={disk.id} disk={disk} from={from} fobDevices={fobDevices} choices={choices}
              helpNfc={i === 0}
              helpProtect={id === shown.find((sid) => byId.get(sid)!.disk.imageFormat !== 'hfe')}
              setControls={{
                canUp: i > 0,
                canDown: i < shown.length - 1,
                onUp: () => move(shown, i, i - 1),
                onDown: () => move(shown, i, i + 1),
                onMoveOut: () => { void moveOut(disk.id); },
              }}
            />
          );
        })
      )}
    </section>
  );
}

/**
 * The set's name in the header, with a pencil to rename it in place. Saved
 * through the title editor's own PATCH /api/games/[id], so the name is
 * recorded as human-edited exactly as an edit there would be. Enter saves;
 * Escape and leaving the field cancel -- a rename is never saved by accident.
 */
function SetName({ gameId, title }: { gameId: string; title: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  // Shown from Enter until the refresh brings the new title, so the old name
  // does not flash back meanwhile.
  const [pending, setPending] = useState<string | null>(null);
  const [seenTitle, setSeenTitle] = useState(title);
  if (seenTitle !== title) {
    setSeenTitle(title);
    setPending(null);
  }

  function start() {
    setDraft(pending ?? title);
    setEditing(true);
  }

  async function save() {
    const name = draft.trim();
    setEditing(false);
    if (name === '' || name === title) return;
    setPending(name);
    let res: Response;
    try {
      res = await fetch(`/api/games/${gameId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: name }),
      });
    } catch {
      setPending(null);
      toast.error('Could not reach the server', { description: 'The set was not renamed.' });
      return;
    }
    if (!res.ok) {
      setPending(null);
      toast.error('Could not rename the set', {
        description: res.status === 404 ? 'This title is no longer in your library.' : 'The name was not accepted.',
      });
      router.refresh();
      return;
    }
    router.refresh();
  }

  if (editing) {
    return (
      <input
        data-testid="set-rename-input" aria-label="Set name" autoFocus maxLength={80}
        value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void save(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        onBlur={() => setEditing(false)}
        className="h-11 min-w-0 max-w-full rounded-[8px] border px-2 text-[13px] font-semibold outline-none sm:h-[28px]"
        style={{ borderColor: 'var(--hairline-strong)', background: 'var(--glass)', color: 'var(--ink)' }}
      />
    );
  }
  const shown = pending ?? title;
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}
            data-testid="set-name" title={shown}>
        {shown}
      </span>
      <button type="button" data-testid="set-rename" aria-label={`Rename set ${shown}`} title="Rename set"
              onClick={start}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors hover:bg-[var(--glass-strong)] sm:h-7 sm:w-7"
              style={{ color: 'var(--muted)' }}>
        <Pencil size={13} aria-hidden />
      </button>
    </span>
  );
}

function ReorderList({ order, byId, onMove }: {
  order: string[];
  byId: Map<string, DiskSetEntry>;
  onMove: (ids: string[], fromIdx: number, toIdx: number) => void;
}) {
  // The collection rail's sensors, for the collection rail's reasons (see
  // collection-provider.tsx): mouse needs 8px of travel so a click on ▲▼ is a
  // click; touch needs a press-and-hold so a swipe still scrolls the page.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    onMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)));
  }

  return (
    <DndContext id="disk-set-dnd" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {order.map((id, i) => (
            <ReorderRow
              key={id}
              entry={byId.get(id)!}
              position={i + 1}
              canUp={i > 0}
              canDown={i < order.length - 1}
              onUp={() => onMove(order, i, i - 1)}
              onDown={() => onMove(order, i, i + 1)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function ReorderRow({ entry, position, canUp, canDown, onUp, onDown }: {
  entry: DiskSetEntry;
  position: number;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const { disk } = entry;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: disk.id });
  const name = diskName(disk);

  return (
    <div
      ref={setNodeRef}
      data-testid={`disk-reorder-row-${disk.id}`}
      className="glass-card flex items-center gap-2 px-2 py-1.5 sm:gap-3 sm:px-3"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 1 : undefined,
        boxShadow: isDragging ? '0 8px 20px rgb(0 0 0 / 0.18)' : undefined,
      }}
    >
      {/* Activators on the grip alone, and touch-action none on it alone: see
          collection-rail.tsx for why a whole-row handle would eat scrolls. */}
      <button
        type="button"
        aria-label={`Drag ${name} to reorder`}
        data-testid={`disk-grip-${disk.id}`}
        {...attributes}
        {...listeners}
        style={{ touchAction: 'none', color: 'var(--muted-2)' }}
        className="grid h-11 w-11 shrink-0 cursor-grab place-items-center active:cursor-grabbing sm:h-8 sm:w-8"
      >
        <GripVertical size={16} />
      </button>
      <span className="w-5 shrink-0 font-mono text-[13px] font-bold" style={{ color: 'var(--ink)' }}
            data-testid={`disk-reorder-no-${disk.id}`}>
        {position}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: 'var(--ink)' }}
            title={name}>
        {name}
      </span>
      <button type="button" aria-label={`Move ${name} up`} data-testid={`disk-reorder-up-${disk.id}`}
              disabled={!canUp} onClick={onUp}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full border disabled:opacity-40 sm:h-8 sm:w-8"
              style={BTN_STYLE}>
        <ChevronUp size={15} />
      </button>
      <button type="button" aria-label={`Move ${name} down`} data-testid={`disk-reorder-down-${disk.id}`}
              disabled={!canDown} onClick={onDown}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full border disabled:opacity-40 sm:h-8 sm:w-8"
              style={BTN_STYLE}>
        <ChevronDown size={15} />
      </button>
    </div>
  );
}
