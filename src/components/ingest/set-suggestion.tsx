'use client';

// The upload-page suggestion panel (disk-sets spec §3, Task 9): shown in the
// Add disks to the library card once a drop's own singles (its library rows in
// the Staging list) look like one set. Purely a
// view over the suggestion the server already built (suggestSet, in
// disk-set-suggest.ts) -- this component only lets the operator rename the
// set, tick/untick which disks join it, reorder the rows, and confirm.
//
// Panel order and ticking are independent: the ▲▼ buttons move a row, but
// unticking a row never moves it (controller ruling) -- so a person can
// untick "Fonts.adf" without losing its place if they retick it.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Suggestion } from '@/lib/disk-set-suggest';
import { addErrorText, isStaleSuggestion } from '@/lib/disk-set-errors';

/** POST /api/games/[id]/disks caps a rename at this many characters. */
const NAME_MAX = 80;

type SuggestedDisk = NonNullable<Suggestion>['disks'][number];

// Same convention as disk-set-section.tsx / add-disks-dialog.tsx: 44px
// targets below `sm` for touch, the house 30px pill from `sm` up.
const PILL =
  'inline-flex h-11 shrink-0 items-center justify-center rounded-full border px-4 text-[12.5px] font-semibold disabled:opacity-50 sm:h-[30px]';
const PILL_STYLE = { borderColor: 'var(--line-strong)', background: 'var(--surface)', color: 'var(--ink)' };
const PILL_PRIMARY_STYLE = { borderColor: 'var(--primary-action)', background: 'var(--primary-action)', color: '#fff' };
const ARROW =
  'grid h-11 w-11 shrink-0 place-items-center rounded-full border disabled:opacity-40 sm:h-8 sm:w-8';

export function SetSuggestion({ suggestion, onDone }: {
  suggestion: NonNullable<Suggestion>;
  /** Called after Accept succeeds and after Dismiss, either way hiding the panel. */
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(suggestion.name.slice(0, NAME_MAX));
  // The panel's own row order, seeded from the server's (ticked first,
  // Install/Workbench first among those -- see rank() in
  // disk-set-suggest.ts). ▲▼ mutate this; ticking does not.
  const [positions, setPositions] = useState<string[]>(() => suggestion.disks.map((d) => d.diskId));
  const [ticked, setTicked] = useState<Record<string, boolean>>(
    () => Object.fromEntries(suggestion.disks.map((d) => [d.diskId, d.ticked])),
  );
  const [busy, setBusy] = useState(false);

  const byId = new Map<string, SuggestedDisk>(suggestion.disks.map((d) => [d.diskId, d]));
  const tickedIds = positions.filter((id) => ticked[id]);
  const canAccept = !busy && tickedIds.length >= 2 && name.trim().length > 0;

  function move(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= positions.length) return;
    const next = [...positions];
    [next[i], next[j]] = [next[j], next[i]];
    setPositions(next);
  }

  async function accept() {
    if (!canAccept) return;
    // The first ticked disk's title becomes the set; the rest of the ticked
    // disks, in panel order, join it (controller ruling).
    const [firstId, ...restIds] = tickedIds;
    const first = byId.get(firstId);
    if (!first) return;

    setBusy(true);
    let res: Response;
    try {
      res = await fetch(`/api/games/${first.gameId}/disks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diskIds: restIds, rename: name.trim() }),
      });
    } catch {
      setBusy(false);
      toast.error('Could not reach the server', { description: 'The set was not made.' });
      return;
    }
    if (!res.ok) {
      setBusy(false);
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      // The disks moved on while the panel was open (another tab made a set
      // of them, or one was deleted): retrying cannot help, so reload the
      // page's data and let the panel go.
      if (isStaleSuggestion(body.error)) {
        toast.error('The disks changed while you were deciding — reloaded');
        router.refresh();
        onDone();
        return;
      }
      toast.error('Could not make the disk set', { description: addErrorText(body.error) });
      return;
    }

    const madeName = name.trim();
    const gameId = first.gameId;
    toast.success(`Made disk set ${madeName}`, {
      action: { label: 'View', onClick: () => router.push(`/games/${gameId}`) },
    });
    onDone();
  }

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border p-4" data-testid="set-suggestion"
         style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
      <div className="flex flex-col gap-2">
        <span className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>
          These {suggestion.disks.length} disks look like one set.
        </span>
        <label
          className="flex h-11 items-center gap-2 rounded-[10px] border px-3 sm:h-[34px]"
          style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
        >
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted-2)' }}>
            Name
          </span>
          <input
            type="text"
            data-testid="set-suggestion-name"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            style={{ color: 'var(--ink)' }}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        {positions.map((id, i) => {
          const d = byId.get(id);
          if (!d) return null;
          return (
            <div
              key={id}
              data-testid={`set-suggestion-row-${id}`}
              className="flex items-center gap-2 rounded-[10px] border px-2 py-1.5 sm:gap-3 sm:px-3"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
            >
              {/* The whole row toggles the tick -- a bare 20px input would be
                  a 20px tap target below `sm`. Same pattern as
                  add-disks-dialog.tsx's title-pick rows. */}
              <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 sm:min-h-0">
                <input
                  type="checkbox"
                  data-testid={`set-suggestion-tick-${id}`}
                  checked={!!ticked[id]}
                  onChange={() => setTicked((t) => ({ ...t, [id]: !t[id] }))}
                  className="h-5 w-5 shrink-0 sm:h-4 sm:w-4"
                />
                <span
                  className="min-w-0 flex-1 truncate text-[13px] font-semibold"
                  title={d.label}
                  style={{ color: 'var(--ink)' }}
                >
                  {d.label}
                </span>
              </label>
              <button
                type="button"
                aria-label={`Move ${d.label} up`}
                data-testid={`set-suggestion-up-${id}`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
                className={ARROW}
                style={PILL_STYLE}
              >
                <ChevronUp size={15} />
              </button>
              <button
                type="button"
                aria-label={`Move ${d.label} down`}
                data-testid={`set-suggestion-down-${id}`}
                disabled={i === positions.length - 1}
                onClick={() => move(i, 1)}
                className={ARROW}
                style={PILL_STYLE}
              >
                <ChevronDown size={15} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="set-suggestion-dismiss"
          onClick={onDone}
          disabled={busy}
          className={PILL}
          style={{ borderColor: 'var(--line-strong)', color: 'var(--ink)' }}
        >
          Not a set
        </button>
        <button
          type="button"
          data-testid="set-suggestion-accept"
          onClick={() => { void accept(); }}
          disabled={!canAccept}
          className={PILL}
          style={PILL_PRIMARY_STYLE}
        >
          {busy ? 'Making…' : 'Make disk set'}
        </button>
      </div>
    </div>
  );
}
