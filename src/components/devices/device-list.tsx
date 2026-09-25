'use client';
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { DeviceListItem } from '@/lib/queries';
import type { FirmwareState, ReleaseRef } from '@/lib/firmware-state';
import { MAX_UPDATE_BATCH, overBatchCap } from '@/lib/firmware-update-rules';
import { DeviceCard } from './device-card';

/**
 * The card list, plus the update selection that lives across it.
 *
 * A client component because the checkboxes and the confirm dialog need state
 * that spans every card — the page stays a server component and hands down
 * plain data. `selectableIds` is computed on the server with the SAME
 * refuseTarget the batch route rejects with, so the UI can never offer what
 * the server would refuse.
 */
export function DeviceList({
  devices, now, states, selectableIds, latest,
}: {
  devices: DeviceListItem[];
  now: number;
  states: FirmwareState[];
  selectableIds: string[];
  latest: ReleaseRef | null;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<{ deviceId: string; name: string; reason: string }[]>([]);

  const selectable = new Set(selectableIds);
  // Intersected with `selectable`, not just with `devices`. LiveRefresh calls
  // router.refresh() while an update is in flight -- that is the point of
  // putting the update into the fingerprint -- so a ticked board can stop
  // being selectable (it reports the target version, or starts applying)
  // and its checkbox disappears while its id is still in `picked`. Submitting
  // it would 409 the whole ALL-OR-NOTHING batch on a device the operator can
  // no longer see or untick.
  const chosen = devices.filter((d) => picked.has(d.id) && selectable.has(d.id));
  // Counted on `chosen`, the list that is actually sent, not on `picked`.
  const untick = overBatchCap(chosen.length);
  const titleId = useId();

  function close() {
    setOpen(false);
    setRefusals([]);
    setPassword('');
  }

  // Escape closes, as on every other dialog here (delete-user-dialog.tsx) --
  // except while the request is in flight. Closing then would hide the
  // outcome of a password-gated action that flashes hardware: the toast
  // still fires, but the refusal list it may come back with has nowhere to
  // render, and the operator is left guessing whether it went.
  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      setRefusals([]);
      setPassword('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  /**
   * Stand an update down. No password: this is not the privileged direction.
   *
   * It exists because without it there is NO way out of a stuck update from
   * the app -- a board that reports 'failed', or one that goes offline after
   * being told, keeps its request forever and its card keeps showing it.
   * The endpoint shipped with no caller; this is the caller.
   */
  async function cancel(id: string) {
    try {
      const res = await fetch('/api/devices/firmware-update', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceIds: [id] }),
      });
      if (res.redirected || !res.ok) {
        toast.error('Could not cancel the update.');
        return;
      }
      // Precise about what this did: a board that already flashed keeps the
      // firmware. Cancelling clears intent, not flash.
      toast.success('Update cancelled. A board that already applied it keeps it.');
      router.refresh();
    } catch {
      toast.error('Could not reach the server. Nothing was changed.');
    }
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function confirm() {
    if (!latest || chosen.length === 0 || untick > 0 || busy || password.length === 0) return;
    setBusy(true);
    setRefusals([]);
    try {
      const res = await fetch('/api/devices/firmware-update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceIds: chosen.map((d) => d.id), version: latest.version, password,
        }),
      });
      // An expired session makes requireOrg() redirect; fetch FOLLOWS the
      // 307 (preserving the POST) to /sign-in, which answers 200 text/html.
      // Every status check below would miss it and the operator would be
      // told three boards were updated when nothing was written and no
      // password was ever checked. Detected before anything else.
      if (res.redirected || !res.headers.get('content-type')?.includes('application/json')) {
        toast.error('Your session expired. Sign in again and retry.');
        return;
      }
      if (res.status === 429) {
        const { retryAfterMs } = await res.json();
        const mins = Math.ceil((retryAfterMs ?? 0) / 60000);
        toast.error(`Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
        return;
      }
      if (res.status === 401) { toast.error('That password was not right.'); return; }
      if (res.status === 409) { setRefusals((await res.json()).refusals ?? []); return; }
      // The update bar keeps a selection inside the cap, so a 400 from this
      // page is a batch that grew past it under a live refresh, or a version
      // string the schema refused. Said as what it is rather than the generic
      // line below, which gives the operator nothing to change.
      if (res.status === 400) {
        toast.error('The server refused this request as malformed.', {
          description: `At most ${MAX_UPDATE_BATCH} boards per update. Nothing was changed.`,
        });
        return;
      }
      if (!res.ok) { toast.error('Could not request the update.'); return; }
      toast.success(`Update requested for ${chosen.length} device${chosen.length === 1 ? '' : 's'}.`);
      close();
      setPicked(new Set());
      router.refresh();
    } catch {
      // Without this, a dropped connection or a non-JSON body left the dialog
      // looking exactly as it does before the first click -- on a
      // password-gated action that flashes hardware, where the operator's
      // only recourse is to press it again and hope.
      toast.error('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {latest && picked.size > 0 && (
        <div className="glass-card flex flex-wrap items-center gap-3 p-4" data-testid="update-bar">
          <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
            {picked.size} selected · Update to{' '}
            {/* The FULL version, never the semver: two releases can share one. */}
            <strong className="break-all font-mono">{latest.version}</strong>
          </span>
          {/* The route's own cap, stated before the password rather than
              discovered after it as a bare 400. Plain text, and only when it
              bites: under the cap it is noise on every update. */}
          {untick > 0 && (
            <span className="basis-full text-[12.5px] sm:basis-auto" data-testid="update-cap"
                  style={{ color: 'var(--amber-text)' }}>
              At most {MAX_UPDATE_BATCH} boards per update — untick {untick}.
            </span>
          )}
          {/* `chosen` can empty out under a live refresh while `picked` still
              has ids -- a ticked board that reports the target version stops
              being selectable. Disabled rather than hidden, so the bar does
              not shift under the cursor mid-click. */}
          <button type="button" data-testid="update-start" onClick={() => setOpen(true)}
                  disabled={chosen.length === 0 || untick > 0}
                  className="rounded-full px-4 py-1.5 text-[13px] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--amber-text)', color: '#16273a' }}>
            Update
          </button>
          <button type="button" onClick={() => setPicked(new Set())}
                  className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Clear
          </button>
        </div>
      )}

      {/*
        Square-ish cards in a grid rather than the old full-width stacked
        list (the approved redesign, option A -- "the disk in the middle").
        2 per row is the base (mobile-first, so this is what a 390px phone
        gets with no override needed), 3 per row from lg up: this card carries
        more prose than the library's thumbnails, so it needs tablet-width
        room that a switch at `sm` (library's own breakpoint, game-grid.tsx)
        would not give it.
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {devices.map((d, i) => (
          <DeviceCard
            key={d.id} device={d} now={now} firmware={states[i]}
            selection={selectable.has(d.id)
              ? { selected: picked.has(d.id), onToggle: toggle }
              : undefined}
            onCancelUpdate={d.desiredFirmwareVersion ? cancel : undefined}
          />
        ))}
      </div>

      {/*
        PORTALLED, as DeleteDiskDialog and the history panel's restore dialog
        are: nothing here sets backdrop-filter today, but a card or wrapper
        that did would become the containing block for `fixed inset-0` and
        wedge the overlay inside it. `open` is only ever set from a click, so
        document is always there by the time this renders.

        A <form>, so Enter in the password field submits -- the keyboard path
        a password prompt is expected to have. confirm() re-checks every
        condition the Update button's `disabled` does, since a form submit
        does not consult that attribute on its own.
      */}
      {open && latest && createPortal((
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgb(0 0 0 / 0.5)' }}>
          <form role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="update-dialog"
                onSubmit={(e) => { e.preventDefault(); void confirm(); }}
                className="glass-card flex max-h-full w-full max-w-lg flex-col gap-3 overflow-y-auto p-6">
            <h2 id={titleId} className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
              Update {chosen.length} device{chosen.length === 1 ? '' : 's'}
            </h2>
            <ul className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--muted)' }}>
              {chosen.map((d) => (
                <li key={d.id} className="break-all font-mono">
                  {d.name} · {d.firmwareVersion ?? 'version unknown'} → {latest.version}
                </li>
              ))}
            </ul>
            {latest.security && (
              <span className="text-[12px] font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--amber-text)' }}>Security release</span>
            )}
            {latest.notes && (
              <p className="text-[13px]" style={{ color: 'var(--ink)' }}>{latest.notes}</p>
            )}
            {/* Said plainly here rather than discovered afterwards. */}
            <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
              A board holding a disk will wait until it is ejected before applying this.
            </p>
            <label className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--muted)' }}>
              Confirm with your password
              {/* autoFocus: the password is the one thing this dialog needs
                  typed, so the caret starts there. */}
              <input type="password" data-testid="update-password" value={password}
                     autoFocus autoComplete="current-password"
                     onChange={(e) => setPassword(e.target.value)}
                     className="rounded-lg px-3 py-2 text-[13px]"
                     style={{ background: 'var(--input-bg)', color: 'var(--ink)' }} />
            </label>
            {refusals.length > 0 && (
              <ul className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--amber-text)' }}>
                {/* Keyed by deviceId: device names have no unique constraint
                    and are freely editable, so two boards called "Amiga" in
                    one refused batch would collide. */}
                {refusals.map((r) => (
                  <li key={r.deviceId}>{r.name}: {r.reason.replace(/_/g, ' ')}</li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={close} disabled={busy} className="text-[13px] disabled:opacity-50"
                      style={{ color: 'var(--muted)' }}>Cancel</button>
              <button type="submit" data-testid="update-confirm"
                      disabled={busy || password.length === 0}
                      className="rounded-full px-4 py-1.5 text-[13px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--amber-text)', color: '#16273a' }}>
                {busy ? 'Requesting…' : 'Update'}
              </button>
            </div>
          </form>
        </div>
      ), document.body)}
    </>
  );
}
