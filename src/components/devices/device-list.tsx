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
  const [refusals, setRefusals] = useState<{ name: string; reason: string }[]>([]);

  const selectable = new Set(selectableIds);
  const chosen = devices.filter((d) => picked.has(d.id));

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
      if (res.status === 401) { toast.error('That password was not right.'); return; }
      if (res.status === 409) { setRefusals((await res.json()).refusals ?? []); return; }
      if (!res.ok) { toast.error('Could not request the update.'); return; }
      toast.success(`Update requested for ${chosen.length} device${chosen.length === 1 ? '' : 's'}.`);
      setOpen(false);
      setPicked(new Set());
      setPassword('');
      router.refresh();
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
                {refusals.map((r) => (
                  <li key={r.name}>{r.name}: {r.reason.replace(/_/g, ' ')}</li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="text-[13px]"
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
