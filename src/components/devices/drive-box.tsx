'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceListItem } from '@/lib/queries';
import type { DeviceState } from '@/lib/device-state';
import type { NextInfo } from '@/lib/next-disk';
import { driveBoxText } from '@/lib/devices-look';
import { driveDiskColor } from '@/lib/library-look';
import { Link } from '@/components/shell/link';
import { HelpTip } from '@/components/help/help-tip';
import { DiskIcon } from '@/components/ui/disk-icon';
import { WpSwitch } from '@/components/games/write-protect-toggle';
import { requestEject, requestWriteProtect } from './device-actions';
import { BOX_BTN, BOX_BTN_STYLE } from './box-button';
import { NextDiskButton } from './next-disk-button';
import { ReinsertButton } from './reinsert-button';

const LABEL_TONE = { 'muted-2': 'var(--muted-2)', muted: 'var(--muted)', amber: 'var(--amber-text)' } as const;

/**
 * DF0 in words and its controls (spec §4): the disk, what it is, whether it is write protected, and Next / Change
 * disk / Eject, or -- on an empty drive -- Re-insert last disk and Open library. Always visible: the glass above is
 * a canvas, and a pending request is only on the board's screen once the board acts on it.
 */
export function DriveBox({ device, state, next, preload }: {
  device: DeviceListItem; state: DeviceState; next: NextInfo | null;
  /** The preload line, already gated by the card (a preload exists, the board converged, not Network before NET_PICK_FW). */
  preload: { text: string; kind: string } | null;
}) {
  const router = useRouter();
  const text = driveBoxText(device, state);
  const holding = state !== 'empty';
  const titleGameId = device.mountedGameId ?? device.desiredGameId;

  const [ejecting, setEjecting] = useState(false);
  const [ejectPending, startEject] = useTransition();
  const ejectable = device.desiredSha256 !== null || device.mountedSha256 !== null;
  async function eject() {
    setEjecting(true);
    try {
      // The card reads "Ejecting…" once the refresh lands -- desired has changed, actual has not yet.
      if (await requestEject(device.id)) startEject(() => router.refresh());
    } finally {
      setEjecting(false);
    }
  }

  const [wpBusy, setWpBusy] = useState(false);
  const [wpPending, startWp] = useTransition();
  // Only a converged board with a disk knows what is mounted; in every other state the switch is a disabled dash.
  const wp = state === 'converged' && device.mountedDiskId !== null ? device.mountedWriteProtected : null;
  async function toggleWp() {
    if (wp === null || device.mountedDiskId === null) return;
    setWpBusy(true);
    try {
      if (await requestWriteProtect(device.mountedDiskId, !wp)) startWp(() => router.refresh());
    } finally {
      setWpBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-[14px] p-4" style={{ background: 'var(--surface-2)' }}
         data-testid={`device-disk-${device.id}`}>
      {holding ? (
        <DiskIcon size={64} color={driveDiskColor(titleGameId)} wp={device.mountedWriteProtected === true} />
      ) : (
        <div aria-hidden="true" className="box-border h-[65px] w-16 shrink-0 rounded-[6px]"
             style={{ border: '1.5px dashed #C4B9A2' }} />
      )}
      <div className="flex min-w-[12rem] flex-1 flex-col gap-[3px]">
        <span className="text-[12px]" style={{ color: LABEL_TONE[text.labelTone] }}>{text.label}</span>
        {state === 'converged' && device.mountedGameId !== null ? (
          <Link href={`/games/${device.mountedGameId}`} data-testid={`device-disk-title-${device.id}`}
                className="text-[17px] font-semibold hover:underline" style={{ overflowWrap: 'anywhere', color: 'var(--ink)' }}>
            {text.title}
          </Link>
        ) : (
          <span className="text-[17px] font-semibold" style={{ overflowWrap: 'anywhere', color: 'var(--ink)' }}>{text.title}</span>
        )}
        {state === 'empty' ? (
          <span className="text-[13px]" style={{ color: 'var(--muted)' }}>{text.meta}</span>
        ) : (
          <span className="font-mono text-[12px]" style={{ color: 'var(--muted)' }}>{text.meta}</span>
        )}
        {preload && (
          <span className="flex items-center gap-1">
            <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid={`device-preload-${device.id}`}
                  data-preload={preload.kind}>
              {preload.text}
            </span>
            <HelpTip topic="next-disk" />
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void toggleWp()} aria-pressed={wp === true}
                disabled={wp === null || wpBusy || wpPending}
                title={wp === null ? 'Shown once the board holds a disk' : undefined}
                data-testid={`device-protection-${device.id}`}
                className={BOX_BTN} style={BOX_BTN_STYLE}>
          {wp === null ? (
            <span aria-hidden="true" className="box-border flex h-[18px] w-8 shrink-0 items-center justify-center rounded-full p-0.5"
                  style={{ background: 'var(--track)' }}>
              <span className="size-3.5 rounded-full" style={{ background: '#FFFDF8', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
            </span>
          ) : <WpSwitch on={wp} />}
          {wp === null ? '—' : wp ? 'Protected' : 'Writable'}
        </button>
        {next && state === 'converged' && <NextDiskButton deviceId={device.id} next={next} />}
        {(state === 'converged' || state === 'pending') && (
          <Link href="/library" data-testid={`device-change-disk-${device.id}`} className={BOX_BTN} style={BOX_BTN_STYLE}>
            Change disk
          </Link>
        )}
        {ejectable && (
          <button type="button" onClick={() => void eject()} disabled={ejecting || ejectPending}
                  data-testid={`eject-${device.id}`} aria-label={ejecting || ejectPending ? 'Ejecting…' : 'Eject'}
                  className="flex h-[38px] items-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 5l7 9H5z" /><rect x="5" y="16.5" width="14" height="2.5" rx="1" />
            </svg>
            {ejecting || ejectPending ? 'Ejecting…' : 'Eject'}
          </button>
        )}
        {state === 'empty' && device.lastDiskId && device.lastDiskTitle && (
          <ReinsertButton deviceId={device.id} diskId={device.lastDiskId} title={device.lastDiskTitle} diskNo={device.lastDiskNo} />
        )}
        {state === 'empty' && (
          <Link href="/library" data-testid={`device-open-library-${device.id}`}
                className="flex h-[38px] items-center rounded-[10px] px-3.5 text-[13px] font-semibold"
                style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
            Open library
          </Link>
        )}
      </div>
    </div>
  );
}
