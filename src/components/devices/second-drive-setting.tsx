'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceListItem } from '@/lib/queries';
import { secondDriveStatus, DF1_SEEN_REASON } from '@/lib/second-drive';
import type { NextInfo } from '@/lib/next-disk';
import { HelpTip } from '@/components/help/help-tip';

/** Second drive (DF1): Off | Next disk of the set (spec §3). Refused while a real DF1 was seen,
 *  with an override behind a second confirmation (operator ruling 2026-10-08). */
export function SecondDriveSetting({ device, next }: { device: DeviceListItem; next?: NextInfo | null }) {
  const id = device.id;
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [step, setStep] = useState<0 | 1>(0);   // 1 = "are you sure" shown

  async function save(mode: 'off' | 'df1', override = false) {
    setBusy(true);
    try {
      const res = await fetch(`/api/devices/${id}/second-drive`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, override }),
      });
      if (res.status === 409) {
        const j = await res.json() as { error: string; reason: string };
        setRefused(j.error === 'df1_seen' ? DF1_SEEN_REASON : j.reason);
        return;
      }
      setRefused(null); setStep(0);
      startRefresh(() => router.refresh());
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
      <label className="flex items-center gap-2">
        Second drive (DF1)
        <select data-testid={`second-drive-${id}`} value={device.secondDrive}
                disabled={!device.secondDriveCapable || busy || refreshing}
                onChange={(e) => save(e.target.value as 'off' | 'df1')}
                className="rounded border px-1 py-0.5" style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
          <option value="off">Off</option>
          <option value="df1">Next disk of the set</option>
        </select>
        <HelpTip topic="second-drive" />
      </label>
      <span data-testid={`second-drive-status-${id}`}>{secondDriveStatus(device)}</span>
      {device.secondDrive === 'df1' && device.secondDriveCapable && (
        <span data-testid={`device-df1-disk-${id}`}>
          {device.df1Sha256 === null ? 'DF1: empty'
            : next?.preload === 'ready' ? `DF1: disk ${next.diskNo}` : 'DF1: next disk ready'}
        </span>
      )}
      {refused && (
        <div className="flex flex-col gap-1 rounded-lg px-2 py-1" style={{ background: 'var(--input-bg)', color: 'var(--amber-text)' }}
             data-testid={`second-drive-refused-${id}`}>
          <span>{refused}. Switching DF1 on would make both drives unreadable.</span>
          {step === 0 ? (
            <button type="button" className="self-start underline" onClick={() => setStep(1)}
                    data-testid={`second-drive-override-${id}`}>Switch on anyway…</button>
          ) : (
            <button type="button" className="self-start font-semibold underline" disabled={busy}
                    onClick={() => save('df1', true)}
                    data-testid={`second-drive-override-confirm-${id}`}>
              Yes, I have removed the other DF1 drive — switch DF1 on
            </button>
          )}
        </div>
      )}
    </div>
  );
}
