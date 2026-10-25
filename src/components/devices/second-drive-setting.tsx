'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceListItem } from '@/lib/queries';
import { secondDriveStatus, DF1_SEEN_REASON, SECOND_DRIVE_NET_FW, secondDriveHelp, sel1Text, df1SeenText, type SecondDriveMode } from '@/lib/second-drive';
import type { NextInfo } from '@/lib/next-disk';
import { HelpTip } from '@/components/help/help-tip';
import { df1LineText } from '@/lib/df1-pick';
import { requestEjectDf1 } from '@/components/devices/device-actions';
import { NetworkChecklist } from '@/components/devices/network-checklist';
import { TransferBox } from '@/components/devices/transfer-box';
import { BOX_BTN_STYLE } from '@/components/devices/box-button';

/** Second drive (DF1): Off | Next disk of the set | Any disk | Network. "Next disk of the set" and "Any disk" are both
 *  the stored 'df1' (spec 2026-10-14 D4's "On"): the menu shows Any disk while DF1 holds a disk mounted into it (a
 *  pick), and choosing Next disk of the set ejects that pick (A4). DF1 cannot sit empty waiting for a pick -- with none
 *  the firmware follows the set -- so Any disk without one says so. Read-only either way: DF1 write-back is backlog.
 *  Refused while a real DF1 was seen, with an override behind a second confirmation (operator ruling 2026-10-08). */
type Radio = 'off' | 'df1' | 'net' | 'any';
/** The board's order (Ruling 15). */
const RADIOS: { value: Radio; label: string }[] = [
  { value: 'off', label: 'Off' }, { value: 'df1', label: 'Next disk of the set' },
  { value: 'net', label: 'Network (PaulaNET)' }, { value: 'any', label: 'Any disk' },
];

export function SecondDriveSetting({ device, next, now, transfer = null, sendLine = null, uploadLine = null }: {
  device: DeviceListItem; next?: NextInfo | null; now: number;
  /** The Transfer box lives in the Network panel when the board reports Network (spec §7). */
  transfer?: { running: boolean } | null; sendLine?: string | null; uploadLine?: { text: string; href: boolean } | null;
}) {
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
  const shown: Radio = device.secondDrive === 'df1' && (hasPick || wantAny) ? 'any' : device.secondDrive;
  // While a save runs the radios are aria-disabled, not disabled: a disabled button drops focus to the body. Input
  // during a save is ignored (not queued); the group is real-disabled only when the board cannot take the setting.
  const saving = busy || refreshing;
  const radioDisabled = (v: Radio) => !device.secondDriveCapable || (v === 'net' && !device.secondDriveNetCapable);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (saving) return;
    const enabled = RADIOS.filter((r) => !radioDisabled(r.value));
    const at = enabled.findIndex((r) => r.value === shown);
    if (at < 0 || enabled.length < 2) return;
    const target = enabled[(at + dir + enabled.length) % enabled.length].value;
    document.querySelector<HTMLElement>(`[data-testid="second-drive-${id}-${target}"]`)?.focus();
    void choose(target);
  }

  async function choose(value: string) {
    if (value === shown) return;
    if (value === 'any') {
      setWantAny(true);
      // A refusal keeps Any disk shown: the override confirmation that follows saves it.
      if (device.secondDrive !== 'df1' && (await save('df1')) === false) setWantAny(false);
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

  async function save(mode: SecondDriveMode, override = false): Promise<boolean | 'refused'> {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/devices/${id}/second-drive`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, override }),
      });
      if (res.status === 409) {
        const j = await res.json() as { error: string; reason: string };
        if (j.error === 'df1_seen') { setPending(mode); setRefused(DF1_SEEN_REASON); return 'refused'; } else setFailed(j.reason);   // m1: only df1_seen offers the override
        return false;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { reason?: string } | null;
        setFailed(j?.reason ?? `Could not save (HTTP ${res.status})`);
        return false;
      }
      setRefused(null); setStep(0);
      startRefresh(() => router.refresh());
      return true;
    } catch {
      setFailed('Could not reach the server');
      return false;
    } finally { setBusy(false); }
  }

  // The tab stop sits on the checked radio, or on the first enabled one when the checked one is disabled.
  const enabledRadios = RADIOS.filter((r) => !radioDisabled(r.value));
  const stop = enabledRadios.some((r) => r.value === shown) ? shown : enabledRadios[0]?.value;
  const sel1 = device.sel1Wired !== null && device.df1Seen !== null;
  const netPanel = device.secondDriveReported === 'net' && device.secondDriveCapable;
  const hasTransfer = transfer !== null || !!sendLine || !!uploadLine;
  const showDisk = device.secondDriveReported === 'df1' && device.secondDriveCapable;
  const hasBody = showDisk || failed || refused;
  return (
    <div className="flex flex-col rounded-[14px] border" style={{ borderColor: 'var(--line)' }} data-testid={`device-df1-${id}`}>
      <div className="flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-center lg:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-[10px] font-mono text-[12px] font-semibold"
                style={{ background: 'var(--track)', color: 'var(--muted)' }}>DF1</span>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="flex items-center gap-1 text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>
              Second drive (DF1)
              <HelpTip topic="second-drive" />
            </span>
            {device.secondDriveCapable && (
              <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`second-drive-help-${id}`}>
                {secondDriveHelp(shown, hasPick)}
              </span>
            )}
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
              {sel1 && (
                <>
                  <span data-testid={`device-sel1-${id}`} data-value={String(device.sel1Wired)}>{sel1Text(device.sel1Wired!)}</span>
                  {' · '}
                  <span data-testid={`device-df1seen-${id}`} data-value={String(device.df1Seen)}>{df1SeenText(device.df1Seen!)}</span>
                  {' · '}
                </>
              )}
              <span data-testid={`second-drive-status-${id}`}>{secondDriveStatus(device)}</span>
            </span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1 lg:items-end">
          <div role="radiogroup" aria-label="Second drive mode" data-testid={`second-drive-${id}`} data-value={shown}
               onKeyDown={onKeyDown} className="seg seg--sm max-w-full flex-wrap">
            {RADIOS.map((r) => (
              <button key={r.value} type="button" role="radio" aria-checked={shown === r.value}
                      tabIndex={r.value === stop ? 0 : -1} disabled={radioDisabled(r.value)} aria-disabled={saving}
                      data-testid={`second-drive-${id}-${r.value}`}
                      onClick={() => { if (!saving) void choose(r.value); }}
                      className="seg-item whitespace-nowrap disabled:opacity-50">
                {r.label}
              </button>
            ))}
          </div>
          {!device.secondDriveNetCapable && (
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`second-drive-net-note-${id}`}>
              Network needs firmware {SECOND_DRIVE_NET_FW} or newer
            </span>
          )}
        </div>
      </div>
      {hasBody && (
        <div className="flex flex-col gap-2 px-4 pb-3.5 text-[12px]" style={{ color: 'var(--muted)' }}>
          {showDisk && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span data-testid={`device-df1-disk-${id}`}>{df1LineText(device, next ?? null)}</span>
              {device.df1DiskId !== null && (
                <button type="button" data-testid={`eject-df1-${id}`} disabled={busy || refreshing}
                        onClick={async () => {
                          setBusy(true);
                          try { if (await requestEjectDf1(id)) startRefresh(() => router.refresh()); }
                          finally { setBusy(false); }
                        }}
                        className="min-h-[30px] rounded-[10px] border px-3 text-[12px] font-medium disabled:opacity-50"
                        style={BOX_BTN_STYLE}>
                  Eject DF1
                </button>
              )}
            </span>
          )}
          {failed && (
            <span role="alert" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
                  data-testid={`second-drive-error-${id}`}>{failed}</span>
          )}
          {refused && (
            <div role="alert" className="flex flex-col gap-1 rounded-lg px-2 py-1" style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}
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
      )}
      {netPanel && (
        <div className="grid gap-5 border-t px-4 pb-3.5 pt-3 md:grid-cols-[minmax(0,1fr)_300px] md:pl-[72px]"
             style={{ borderColor: 'var(--hairline)' }}>
          <NetworkChecklist device={device} now={now} />
          {hasTransfer && <TransferBox deviceId={id} transfer={transfer} sendLine={sendLine} uploadLine={uploadLine} />}
        </div>
      )}
    </div>
  );
}
