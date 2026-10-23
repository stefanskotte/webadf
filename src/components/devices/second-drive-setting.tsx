'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceListItem } from '@/lib/queries';
import { secondDriveStatus, DF1_SEEN_REASON, SECOND_DRIVE_NET_FW, type SecondDriveMode } from '@/lib/second-drive';
import type { NextInfo } from '@/lib/next-disk';
import { HelpTip } from '@/components/help/help-tip';
import { df1LineText } from '@/lib/df1-pick';
import { requestEjectDf1 } from '@/components/devices/device-actions';
import { NetworkChecklist } from '@/components/devices/network-checklist';

/** Second drive (DF1): Off | Next disk of the set | Any disk | Network. "Next disk of the set" and "Any disk" are both
 *  the stored 'df1' (spec 2026-10-14 D4's "On"): the menu shows Any disk while DF1 holds a disk mounted into it (a
 *  pick), and choosing Next disk of the set ejects that pick (A4). DF1 cannot sit empty waiting for a pick -- with none
 *  the firmware follows the set -- so Any disk without one says so. Read-only either way: DF1 write-back is backlog.
 *  Refused while a real DF1 was seen, with an override behind a second confirmation (operator ruling 2026-10-08). */
export function SecondDriveSetting({ device, next, now }: { device: DeviceListItem; next?: NextInfo | null; now: number }) {
  const id = device.id;
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<SecondDriveMode>('df1');   // the mode the override confirms (ruling 17)
  const [step, setStep] = useState<0 | 1>(0);   // 1 = "are you sure" shown
  // "Any disk" chosen while DF1 holds no pick yet: shown as chosen until the page knows otherwise.
  const [wantAny, setWantAny] = useState(false);
  const hasPick = device.df1DiskId !== null;
  const shown = device.secondDrive === 'df1' && (hasPick || wantAny) ? 'any' : device.secondDrive;

  async function choose(value: string) {
    if (value === 'any') {
      setWantAny(true);
      if (device.secondDrive !== 'df1') await save('df1');
      return;
    }
    setWantAny(false);
    if (value === 'df1' && device.secondDrive === 'df1') {
      // Already on: "Next disk of the set" is DF1 with no pick, so drop the pick.
      if (!hasPick) return;
      setBusy(true);
      try { if (await requestEjectDf1(id)) startRefresh(() => router.refresh()); }
      finally { setBusy(false); }
      return;
    }
    await save(value as SecondDriveMode);
  }

  async function save(mode: SecondDriveMode, override = false) {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/devices/${id}/second-drive`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, override }),
      });
      if (res.status === 409) {
        const j = await res.json() as { error: string; reason: string };
        if (j.error === 'df1_seen') { setPending(mode); setRefused(DF1_SEEN_REASON); } else setFailed(j.reason);   // m1: only df1_seen offers the override
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { reason?: string } | null;
        setFailed(j?.reason ?? `Could not save (HTTP ${res.status})`);
        return;
      }
      setRefused(null); setStep(0);
      startRefresh(() => router.refresh());
    } catch {
      setFailed('Could not reach the server');
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
      <label className="flex flex-wrap items-center gap-x-2 gap-y-1">
        Second drive (DF1)
        <select data-testid={`second-drive-${id}`} value={shown}
                disabled={!device.secondDriveCapable || busy || refreshing}
                onChange={(e) => void choose(e.target.value)}
                className="w-40 min-w-0 max-w-full rounded border px-1 py-0.5" style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
          <option value="off">Off</option>
          <option value="df1">Next disk of the set</option>
          <option value="any">Any disk (read-only)</option>
          <option value="net" disabled={!device.secondDriveNetCapable}>
            {device.secondDriveNetCapable ? 'Network (PaulaNET)' : `Network (PaulaNET) — needs firmware ${SECOND_DRIVE_NET_FW}`}
          </option>
        </select>
        <HelpTip topic="second-drive" />
      </label>
      <span data-testid={`second-drive-status-${id}`}>{secondDriveStatus(device)}</span>
      {device.secondDriveCapable && (
        <span data-testid={`second-drive-help-${id}`}>
          {shown === 'any'
            ? `DF1 holds a disk you mount into DF1 from the library, read-only.${hasPick ? ''
              : ' Mount one with a title’s Mount → DF1; until then DF1 holds the next disk of the set.'}`
            : shown === 'df1' ? 'DF1 holds the next disk of the set, read-only, so a game asking for its next disk finds it.'
            : shown === 'net' ? 'The Amiga’s network: the driver disk sits in DF1 and PaulaNET carries Ethernet over the floppy cable.'
            : 'No second drive: the Amiga sees DF0 only.'}
        </span>
      )}
      {device.secondDriveReported === 'df1' && device.secondDriveCapable && (   /* m2: what the board runs */
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span data-testid={`device-df1-disk-${id}`}>{df1LineText(device, next ?? null)}</span>
          {device.df1DiskId !== null && (
            <button type="button" data-testid={`eject-df1-${id}`} disabled={busy || refreshing}
                    onClick={async () => {
                      setBusy(true);
                      try { if (await requestEjectDf1(id)) startRefresh(() => router.refresh()); }
                      finally { setBusy(false); }
                    }}
                    className="rounded border px-1.5 py-0.5 font-semibold disabled:opacity-50"
                    style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
              Eject DF1
            </button>
          )}
        </span>
      )}
      {device.secondDriveReported === 'net' && device.secondDriveCapable && (
        <span className="flex items-center gap-1">
          <NetworkChecklist device={device} now={now} />
          <HelpTip topic="network" />
        </span>
      )}
      {failed && (
        <span role="alert" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`second-drive-error-${id}`}>{failed}</span>
      )}
      {refused && (
        <div role="alert" className="flex flex-col gap-1 rounded-lg px-2 py-1" style={{ background: 'var(--input-bg)', color: 'var(--amber-text)' }}
             data-testid={`second-drive-refused-${id}`}>
          <span>{refused}. Switching DF1 on would make both drives unreadable.</span>
          {step === 0 ? (
            <button type="button" className="self-start underline" onClick={() => setStep(1)}
                    data-testid={`second-drive-override-${id}`}>Switch on anyway…</button>
          ) : (
            <button type="button" className="self-start font-semibold underline" disabled={busy}
                    onClick={() => save(pending, true)}
                    data-testid={`second-drive-override-confirm-${id}`}>
              Yes, I have removed the other DF1 drive — switch DF1 on
            </button>
          )}
        </div>
      )}
    </div>
  );
}
