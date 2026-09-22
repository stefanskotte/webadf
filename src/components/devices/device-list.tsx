'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { DeviceListItem } from '@/lib/queries';
import type { FirmwareState, ReleaseRef } from '@/lib/firmware-state';
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

  function close() {
    setOpen(false);
    setRefusals([]);
    setPassword('');
  }

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
    if (!latest) return;
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
      if (res.status === 401) { toast.error('That password was not right.'); return; }
      if (res.status === 409) { setRefusals((await res.json()).refusals ?? []); return; }
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
          <button type="button" data-testid="update-start" onClick={() => setOpen(true)}
                  className="rounded-full px-4 py-1.5 text-[13px] font-semibold"
                  style={{ background: 'var(--amber-text)', color: '#16273a' }}>
            Update
          </button>
          <button type="button" onClick={() => setPicked(new Set())}
                  className="text-[13px]" style={{ color: 'var(--muted)' }}>
            Clear
          </button>
        </div>
      )}

      {devices.map((d, i) => (
        <DeviceCard
          key={d.id} device={d} now={now} firmware={states[i]}
          selection={selectable.has(d.id)
            ? { selected: picked.has(d.id), onToggle: toggle }
            : undefined}
          onCancelUpdate={d.desiredFirmwareVersion ? cancel : undefined}
        />
      ))}

      {open && latest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ background: 'rgb(0 0 0 / 0.5)' }} data-testid="update-dialog">
          <div className="glass-card flex w-full max-w-lg flex-col gap-3 p-6">
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
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
              <input type="password" data-testid="update-password" value={password}
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
              <button type="button" onClick={close} className="text-[13px]"
                      style={{ color: 'var(--muted)' }}>Cancel</button>
              <button type="button" data-testid="update-confirm"
                      disabled={busy || password.length === 0} onClick={confirm}
                      className="rounded-full px-4 py-1.5 text-[13px] font-semibold disabled:opacity-50"
                      style={{ background: 'var(--amber-text)', color: '#16273a' }}>
                {busy ? 'Requesting…' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
