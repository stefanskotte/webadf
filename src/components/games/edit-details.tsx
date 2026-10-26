'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { GameDetail } from '@/lib/queries';
import { GROUP_FIELDS, type Group } from '@/lib/game-edit';

/**
 * Filling in a title's details by hand, and handing a group back to the
 * scanners.
 *
 * NOT part of GameFacts, deliberately: that block renders nothing at all when
 * a game has never been enriched, which is exactly the case where a person
 * most needs to type something in. The editor has to be reachable on every
 * title, enriched or not.
 *
 * The form posts every field it shows, changed or not; the server works out
 * which groups actually changed and stamps only those. That split is on
 * purpose -- a client that decided authority for itself would be a client
 * that could freeze a row by being wrong.
 */

const LABELS: Record<string, string> = {
  title: 'Title', year: 'Year', publisher: 'Publisher',
  developer: 'Developer', players: 'Players', genre: 'Genre', chipset: 'Chipset',
  description: 'Description', history: 'Notes',
};

const GROUP_TITLE: Record<Group, string> = {
  identity: 'Identity',
  facts: 'Facts',
  prose: 'Description',
};

/** Said in the person's terms, not the column's. */
function ownerLine(source: string | null, group: Group): string {
  if (source === 'human') return 'Edited by you — scans will not change it';
  if (source === 'tosec') return 'From the TOSEC identity scan';
  if (source === 'openretro') return 'From OpenRetro';
  if (source === 'filename') return 'Taken from the uploaded filename';
  // NULL means two different things depending on the column, so it is worth
  // saying the right one: nothing has ever written facts or prose, whereas a
  // NULL identity would mean a human owns it.
  return group === 'identity' ? 'Not set by any scan' : 'Nothing has filled this in yet';
}

const MULTILINE = new Set(['description', 'history']);

/** Where the page puts the open panel: an empty div under the hero (games/[id]/page.tsx). */
export const EDIT_SLOT_ID = 'edit-panel-slot';

export function EditDetails({ game }: { game: GameDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  // Focus follows the panel: into the title field when it opens, back to the trigger when it closes (save, reset,
  // Cancel), so a keyboard user is never left on a button that just disappeared.
  useEffect(() => {
    if (open) titleRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const [values, setValues] = useState<Record<string, string>>(() => initial(game));

  function initial(g: GameDetail): Record<string, string> {
    const v: Record<string, string> = {};
    for (const group of Object.keys(GROUP_FIELDS) as Group[]) {
      for (const f of GROUP_FIELDS[group]) {
        const raw = (g as unknown as Record<string, unknown>)[f];
        v[f] = raw === null || raw === undefined ? '' : String(raw);
      }
    }
    return v;
  }

  const sourceFor: Record<Group, string | null> = {
    identity: game.metadataSource,
    facts: game.factsSource,
    prose: game.proseSource,
  };

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/games/${game.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.detail ?? 'Could not save those details');
        return;
      }
      const changed: Group[] = body?.changed ?? [];
      // Named for what happened, including the case where nothing did --
      // silently closing on an unchanged form reads as a failed save.
      toast.success(changed.length === 0 ? 'No changes to save' : 'Details saved');
      setOpen(false);
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function reset(group: Group) {
    setBusy(true);
    try {
      const res = await fetch(`/api/games/${game.id}/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error('Could not undo that');
        return;
      }
      // Two different outcomes, said differently: a group with nothing ever
      // scanned can only be released, not restored, and claiming otherwise
      // would be a lie the next page render exposes.
      toast.success(body?.restored
        ? `${GROUP_TITLE[group]} restored from the scan`
        : `${GROUP_TITLE[group]} will be filled in by the next scan`);
      setValues(initial(game));
      setOpen(false);
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const panel = (
    <div data-testid="edit-panel">
      <div className="glass-card flex flex-col gap-5 rounded-2xl p-5">
        {(Object.keys(GROUP_FIELDS) as Group[]).map((group) => (
          <section key={group} className="flex flex-col gap-2" data-testid={`edit-group-${group}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-bold" style={{ color: 'var(--ink)' }}>
                {GROUP_TITLE[group]}
              </h2>
              <div className="flex items-center gap-3">
                <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}
                      data-testid={`edit-owner-${group}`}>
                  {ownerLine(sourceFor[group], group)}
                </span>
                {sourceFor[group] === 'human' && (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid={`edit-reset-${group}`}
                    onClick={() => reset(group)}
                    className="rounded-lg border px-2 py-0.5 text-[11.5px] font-semibold disabled:opacity-50"
                    style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
                  >
                    Use scanned data
                  </button>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {GROUP_FIELDS[group].map((field) => (
                <label key={field} className="flex flex-col gap-1"
                       style={{ gridColumn: MULTILINE.has(field) ? '1 / -1' : undefined }}>
                  <span className="text-[11.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                    {LABELS[field]}
                  </span>
                  {MULTILINE.has(field) ? (
                    <textarea
                      rows={4}
                      data-testid={`edit-field-${field}`}
                      value={values[field] ?? ''}
                      disabled={busy}
                      onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                      className="rounded-[10px] border px-3 py-2 text-[13px]"
                      style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--ink)' }}
                    />
                  ) : (
                    <input
                      ref={field === 'title' ? titleRef : undefined}
                      data-testid={`edit-field-${field}`}
                      value={values[field] ?? ''}
                      disabled={busy}
                      inputMode={field === 'year' ? 'numeric' : undefined}
                      onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                      className="h-10 rounded-[10px] border px-3 text-[13px]"
                      style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--ink)' }}
                    />
                  )}
                </label>
              ))}
            </div>
          </section>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            data-testid="edit-save"
            onClick={save}
            className="h-[38px] max-sm:min-h-11 rounded-[10px] px-4 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--primary-action)' }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={busy}
            data-testid="edit-cancel"
            onClick={() => setOpen(false)}
            className="h-[38px] max-sm:min-h-11 rounded-[10px] px-3.5 text-[13px] font-medium disabled:opacity-50"
            style={{ color: 'var(--muted)' }}
          >
            Cancel
          </button>
          <p className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
            Only what you change is kept from future scans.
          </p>
        </div>
      </div>
    </div>
  );

  // The trigger lives in the title hero; the panel opens full width in the slot under it (title-page layout, spec
  // §5.1). One component owns both, so the form's state is one thing; a portal carries the panel to its slot.
  // `open` is only ever true after a click, i.e. after hydration, so the slot lookup never runs during SSR.
  const slot = open && typeof document !== 'undefined' ? document.getElementById(EDIT_SLOT_ID) : null;
  // No slot on the page: show the panel right here rather than hide the trigger and show nothing.
  if (open && !slot) return panel;
  return (
    <>
      {!open && (
      <button
        ref={triggerRef}
        type="button"
        data-testid="edit-details"
        onClick={() => { setValues(initial(game)); setOpen(true); }}
        className="inline-flex h-[38px] max-sm:min-h-11 items-center gap-2 rounded-[10px] border px-3.5 text-[13px] font-medium"
        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
        Edit details
      </button>
      )}
      {open && slot ? createPortal(panel, slot) : null}
    </>
  );
}
