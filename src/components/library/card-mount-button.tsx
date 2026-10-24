'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Eject, Play } from 'lucide-react';
import { holdAction, holdLabel, type Hold } from '@/lib/drive-holds';
import { df1Option, type Df1Board } from '@/lib/df1-pick';

/** A board the org has paired, as the page loaded it. `df1`: its DF1 rules' inputs, null unless DF1 is On. */
export type DriveDevice = { id: string; name: string; df1: Df1Board | null };
/** One disk of a title, labelled as the title page labels it; format and size for DF1's rule (spec 2026-10-14 §3.1). */
export type DriveDisk = { id: string; diskNo: number; imageFormat: string; sizeBytes: number };
/**
 * What the library grid needs for the mount control and the ring: the org's
 * boards, which titles are in a drive (drive-holds.ts), and every set's disks
 * for "which disk?". Null when the org has no board: no control is drawn.
 */
export type DriveContext = {
  devices: DriveDevice[];
  holds: Record<string, Hold[]>;
  disksByGame: Record<string, DriveDisk[]>;
} | null;

/**
 * The ring on a card whose disk is in a drive: solid once the board confirms,
 * dashed while it is only asked for. Drawn by its own element 2px outside the
 * card -- no layout space, nothing over the cover -- rather than by the card's
 * `outline`, which would replace the link's keyboard focus ring.
 */
export function DriveRing({ holds, compact = false }: { holds: Hold[] | undefined; compact?: boolean }) {
  if (!holds || holds.length === 0) return null;
  const mounted = holds.some((h) => h.state === 'mounted');
  // `compact`: the table row's marker, the same ring drawn round the row's
  // cover thumbnail rather than round a whole card.
  return (
    <span aria-hidden data-testid="drive-ring"
          className={`pointer-events-none absolute border-2 ${compact ? '-inset-[3px]' : '-inset-[4px]'}`}
          style={{
            borderStyle: mounted ? 'solid' : 'dashed',
            borderColor: 'var(--primary-action)',
            borderRadius: compact ? '7px' : 'calc(var(--radius-card) + 4px)',
          }} />
  );
}

const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };

/** The props every part of the mount control shares: the title, how many disks it has, and the org's boards. */
type CardMountProps = {
  gameId: string; title: string; diskCount: number; singleDiskId: string | null;
  drives: NonNullable<DriveContext>;
};

/**
 * The mount control's logic, without any markup: what the title holds, which disks it could mount, and `act` /
 * `undo` (mount, eject, cancel with the toasts and the Undo). `CardMountButton` and `CardMountDialog` use it, and
 * the title menu calls `act` directly for a one-click Mount or Eject.
 * `available`: false when there is no board
 * or no disk, where the control draws nothing.
 */
export function useCardMount({ gameId, diskCount, singleDiskId, drives }: Omit<CardMountProps, 'title'>) {
  const router = useRouter();
  const holds = drives.holds[gameId] ?? [];
  // disksByGame carries every title on the page (library/page.tsx), with what DF1's rule needs. The single-disk
  // fallback is never reached from that page; without a format DF1 refuses rather than guesses.
  const disks: DriveDisk[] = drives.disksByGame[gameId]
    ?? (diskCount === 1 && singleDiskId ? [{ id: singleDiskId, diskNo: 1, imageFormat: 'unknown', sizeBytes: 0 }] : []);
  const [busy, setBusy] = useState(false);
  const available = drives.devices.length > 0 && disks.length > 0;
  const ejecting = holds.length > 0;

  /** Mount `disk` on `device`, or empty the drive (`disk` null). `cancel`: this undoes a request. `toDf1`: into DF1. */
  async function act(device: string, disk: string | null, cancel = false, toDf1 = false) {
    setBusy(true);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/devices/${device}/${disk ? 'mount' : 'eject'}`, disk
          ? { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(toDf1 ? { diskId: disk, drive: 'df1' } : { diskId: disk }) }
          : toDf1
            ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ drive: 'df1' }) }
            : { method: 'POST' });
      } catch {
        toast.error('Could not reach the server');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { reason?: unknown; error?: unknown } | null;
        toast.error(cancel ? 'Could not cancel' : disk ? 'Could not mount' : 'Could not eject', {
          description: typeof body?.reason === 'string' ? body.reason
            : body?.error === 'not_found' ? 'That disk or board is no longer in your library.'
            : `The server answered ${res.status}.`,
        });
        return;
      }
      if (disk && !cancel) {
        // Undo (A3): put back what the drive held before this request -- the route says which (`undo.diskId`), or
        // null for "it was empty", which is an eject. It goes through act() as a cancel, like the card's own Cancel.
        const body = await res.json().catch(() => null) as { undo?: { diskId?: string | null } } | null;
        const back = body?.undo ? body.undo.diskId ?? null : undefined;
        toast.success(toDf1 ? 'Mount into DF1 requested' : 'Mount requested', back === undefined ? undefined : {
          action: { label: 'Undo', onClick: () => { void act(device, back, true, toDf1); } },
        });
      } else {
        toast.success(cancel ? 'Mount cancelled' : 'Eject requested');
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Eject a confirmed disk; Cancel a request. A Cancel while the board still
   * holds a confirmed other disk asks for that disk again rather than emptying
   * the drive -- calling off a swap must not eject what the Amiga may be
   * running from (drive-holds.ts revertDiskId, as mount-choice.ts does).
   */
  function undo(h: Hold) {
    const cancel = holdAction(h) === 'Cancel';
    return act(h.deviceId, cancel ? h.revertDiskId : null, cancel);
  }

  return { holds, disks, busy, available, ejecting, act, undo };
}

/**
 * Mount or eject a title from its library card. Same look and placement as
 * the NFC, history and delete controls beside it, and the same picker as the
 * NFC button: one click when there is one disk and one board, otherwise
 * "which disk?" and "which board?". When a disk of this title is in a drive
 * the control becomes Eject for that board (or asks which, if several).
 *
 * The request is the existing one the title page uses (/api/devices/[id]/mount
 * and /eject). The board acts on its next poll; the layout's live poller is
 * what turns the dashed ring solid once it reports.
 */
export function CardMountButton(props: CardMountProps) {
  const { gameId, title, diskCount, drives } = props;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mount = useCardMount(props);
  const { holds, disks, busy, available, ejecting, act, undo } = mount;
  if (!available) return null;

  function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (ejecting) {
      if (holds.length === 1) { void undo(holds[0]); return; }
      setOpen(true);
      return;
    }
    const onlyDisk = disks.length === 1 ? disks[0].id : null;
    const onlyDevice = drives.devices.length === 1 ? drives.devices[0].id : null;
    // A board with DF1 On always asks which drive.
    if (onlyDisk && onlyDevice && drives.devices[0].df1 === null) { void act(onlyDevice, onlyDisk); return; }
    setOpen(true);
  }

  const single = holds.length === 1 ? holds[0] : null;
  const verb = single ? holdAction(single) : 'Eject';
  const label = ejecting
    ? `${holds.map((h) => holdLabel(h, diskCount)).join('; ')} · ${single ? verb : 'Eject or cancel'}`
    : 'Mount';
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-testid={`${ejecting ? 'card-eject' : 'card-mount'}-${gameId}`}
      aria-label={ejecting
        ? (single ? `${verb} ${title} — ${holdLabel(single, diskCount)}` : `Eject or cancel ${title}`)
        : `Mount ${title}`}
      title={label}
      disabled={busy}
      onClick={onClick}
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--glass-strong)] hover:text-[var(--ink)] disabled:opacity-50"
      style={{ color: ejecting ? 'var(--primary-action)' : 'var(--faint)' }}
    >
      {ejecting
        ? <Eject size={14} strokeWidth={1.75} aria-hidden />
        : <Play size={14} strokeWidth={1.75} aria-hidden />}
    </button>
  );
  return (
    <>
      {trigger}
      <CardMountDialog {...props} mount={mount} open={open} onClose={() => { setOpen(false); triggerRef.current?.focus(); }} />
    </>
  );
}

/**
 * The controlled picker behind `CardMountButton`, also rendered by the title menu (outside its popup).
 * `open` / `onClose`: the caller owns visibility (Close, Escape and the backdrop call `onClose`, and so does a
 * request once it starts); the rest are the button's props. Renders nothing while closed or when there is no board
 * or no disk; each opening starts with the choices cleared (or preselected when there is only one).
 */
export function CardMountDialog(props: CardMountProps & {
  open: boolean; onClose: () => void;
  /** The caller's own `useCardMount` result, when it has one (the button shares its busy state); else made here. */
  mount?: ReturnType<typeof useCardMount>;
}) {
  const { mount, ...rest } = props;
  return mount ? <CardMountDialogWith {...rest} m={mount} /> : <CardMountDialogOwn {...rest} />;
}

type DialogState = CardMountProps & { open: boolean; onClose: () => void };

function CardMountDialogOwn(props: DialogState) {
  const m = useCardMount(props);
  return <CardMountDialogWith {...props} m={m} />;
}

function CardMountDialogWith({ open, onClose, m, ...rest }: DialogState & { m: ReturnType<typeof useCardMount> }) {
  if (!open || !m.available) return null;
  return <CardMountPicker {...rest} m={m} onClose={onClose} />;
}

function CardMountPicker({ title, diskCount, drives, m, onClose }: Omit<CardMountProps, 'gameId' | 'singleDiskId'> & {
  m: ReturnType<typeof useCardMount>; onClose: () => void;
}) {
  const { holds, disks, ejecting, undo } = m;
  // A request starting closes the picker first, as it always did.
  const act: typeof m.act = (...a) => { onClose(); return m.act(...a); };
  const onlyDisk = disks.length === 1 ? disks[0].id : null;
  const onlyDevice = drives.devices.length === 1 ? drives.devices[0].id : null;
  const [diskId, setDiskId] = useState<string | null>(ejecting ? null : onlyDisk);
  const [deviceId, setDeviceId] = useState<string | null>(ejecting ? null : onlyDevice);
  const [drive, setDrive] = useState<'df0' | 'df1'>('df0');
  const titleId = useId();
  const close = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pill = 'rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50';
  const choice = (on: boolean) => ({
    className: 'rounded-lg px-3 py-1.5 text-[12.5px] font-semibold',
    style: on
      ? { background: 'var(--primary-action)', color: 'white' }
      : { background: 'var(--glass-strong)', color: 'var(--ink)' },
  });
  // Ejecting from several boards picks among the boards that hold it; mounting
  // picks among all of them.
  const boards: DriveDevice[] = ejecting
    ? holds.map((h) => ({ id: h.deviceId, name: holdLabel(h, diskCount), df1: null }))
    : drives.devices;
  const ready = ejecting ? deviceId !== null : diskId !== null && deviceId !== null;
  const chosenHold = ejecting ? holds.find((h) => h.deviceId === deviceId) ?? null : null;
  // DF1 (spec 2026-10-14 §3.3): offered when the chosen board runs On. The disk already in DF1 is ejected from
  // the board's card (plan ruling 10), so here it reads as a refusal.
  const chosenBoard = drives.devices.find((d) => d.id === deviceId) ?? null;
  const chosenDisk = disks.find((d) => d.id === diskId) ?? null;
  const df1 = !ejecting && chosenBoard?.df1 && chosenDisk ? df1Option(chosenBoard.df1, chosenDisk) : null;
  const df1Usable = df1 !== null && df1.enabled && !df1.isThisDisk;
  const df1Reason = df1 === null ? 'Choose a disk first' : df1.isThisDisk ? 'Already in DF1' : df1.reason;
  const showDrive = !ejecting && chosenBoard !== null && chosenBoard.df1 !== null;
  const useDf1 = showDrive && drive === 'df1' && df1Usable;

  return (
    <>
      {createPortal((
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'var(--scrim)' }}
          onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}
          onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="card-mount-dialog"
               className="glass-card wf-modal flex max-h-full w-full max-w-[440px] flex-col gap-3 overflow-y-auto p-6 text-left">
            <h2 id={titleId} className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>
              {ejecting ? 'Eject or cancel' : 'Mount'}
            </h2>
            <p className="break-words text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</p>
            {!ejecting && disks.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Which disk?</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Disk">
                  {disks.map((d) => (
                    <button key={d.id} type="button" data-testid={`card-mount-disk-${d.id}`}
                            aria-pressed={diskId === d.id} onClick={() => setDiskId(d.id)} {...choice(diskId === d.id)}>
                      Disk {d.diskNo}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {boards.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Which board?</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Board">
                  {boards.map((d) => (
                    <button key={d.id} type="button" data-testid={`card-mount-device-${d.id}`}
                            aria-pressed={deviceId === d.id} onClick={() => setDeviceId(d.id)} {...choice(deviceId === d.id)}>
                      <span className="break-all">{d.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {showDrive && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Which drive?</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Drive">
                  <button type="button" data-testid="card-mount-drive-df0" aria-pressed={!useDf1}
                          onClick={() => setDrive('df0')} {...choice(!useDf1)}>
                    DF0
                  </button>
                  <button type="button" data-testid="card-mount-drive-df1" aria-pressed={useDf1}
                          disabled={!df1Usable} onClick={() => setDrive('df1')}
                          className={`${choice(useDf1).className} disabled:opacity-50`} style={choice(useDf1).style}>
                    DF1
                  </button>
                </div>
                <span className="text-[11.5px]" style={{ color: 'var(--muted)' }} data-testid="card-mount-df1-note">
                  {df1Usable ? 'DF1 is read-only' : df1Reason}
                </span>
              </div>
            )}
            <div className="mt-2 flex items-center justify-end gap-2">
              <button type="button" onClick={close} autoFocus={!ready} className={pill} style={{ color: 'var(--muted)' }}>Close</button>
              <button type="button" data-testid="card-mount-confirm" autoFocus={ready} disabled={!ready}
                      onClick={() => {
                        if (chosenHold) { onClose(); void undo(chosenHold); }
                        else if (deviceId && diskId) void act(deviceId, diskId, false, useDf1);
                      }}
                      className={`${pill} text-white`} style={{ background: 'var(--primary-action)' }}>
                {chosenHold ? holdAction(chosenHold) : ejecting ? 'Eject' : useDf1 ? 'Mount into DF1' : 'Mount'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </>
  );
}
