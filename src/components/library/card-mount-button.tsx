'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Eject, Play } from 'lucide-react';
import { holdAction, holdLabel, type Hold } from '@/lib/drive-holds';

/** A board the org has paired, as the page loaded it. */
export type DriveDevice = { id: string; name: string };
/** One disk of a title, labelled as the title page labels it. */
export type DriveDisk = { id: string; diskNo: number };
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
export function DriveRing({ holds }: { holds: Hold[] | undefined }) {
  if (!holds || holds.length === 0) return null;
  const mounted = holds.some((h) => h.state === 'mounted');
  return (
    <span aria-hidden data-testid="drive-ring"
          className="pointer-events-none absolute -inset-[4px] border-2"
          style={{
            borderStyle: mounted ? 'solid' : 'dashed',
            borderColor: 'var(--primary-action)',
            borderRadius: 'calc(var(--radius-card) + 4px)',
          }} />
  );
}

const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };

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
export function CardMountButton({ gameId, title, diskCount, singleDiskId, drives }: {
  gameId: string; title: string; diskCount: number; singleDiskId: string | null;
  drives: NonNullable<DriveContext>;
}) {
  const router = useRouter();
  const holds = drives.holds[gameId] ?? [];
  const disks: DriveDisk[] = diskCount === 1 && singleDiskId
    ? [{ id: singleDiskId, diskNo: 1 }]
    : drives.disksByGame[gameId] ?? [];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diskId, setDiskId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  /** Close the picker and hand focus back to the button that opened it. */
  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (drives.devices.length === 0 || disks.length === 0) return null;
  const ejecting = holds.length > 0;

  /** Mount `disk` on `device`, or empty the drive (`disk` null). `cancel`: this undoes a request. */
  async function act(device: string, disk: string | null, cancel = false) {
    setBusy(true);
    setOpen(false);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/devices/${device}/${disk ? 'mount' : 'eject'}`, disk
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diskId: disk }) }
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
      toast.success(cancel ? 'Mount cancelled' : disk ? 'Mount requested' : 'Eject requested');
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

  function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (ejecting) {
      if (holds.length === 1) { void undo(holds[0]); return; }
      setDeviceId(null);
      setOpen(true);
      return;
    }
    const onlyDisk = disks.length === 1 ? disks[0].id : null;
    const onlyDevice = drives.devices.length === 1 ? drives.devices[0].id : null;
    if (onlyDisk && onlyDevice) { void act(onlyDevice, onlyDisk); return; }
    setDiskId(onlyDisk);
    setDeviceId(onlyDevice);
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
  if (!open) return trigger;

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
    ? holds.map((h) => ({ id: h.deviceId, name: holdLabel(h, diskCount) }))
    : drives.devices;
  const ready = ejecting ? deviceId !== null : diskId !== null && deviceId !== null;
  const chosenHold = ejecting ? holds.find((h) => h.deviceId === deviceId) ?? null : null;

  return (
    <>
      {trigger}
      {createPortal((
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgb(11 18 28 / 0.55)' }}
          onPointerDown={stop} onMouseDown={stop} onTouchStart={stop}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}
          onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="card-mount-dialog"
               className="glass-card flex max-h-full w-full max-w-[440px] flex-col gap-3 overflow-y-auto p-6 text-left">
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
            <div className="mt-2 flex items-center justify-end gap-2">
              <button type="button" onClick={close} autoFocus={!ready} className={pill} style={{ color: 'var(--muted)' }}>Close</button>
              <button type="button" data-testid="card-mount-confirm" autoFocus={ready} disabled={!ready}
                      onClick={() => {
                        if (chosenHold) void undo(chosenHold);
                        else if (deviceId && diskId) void act(deviceId, diskId);
                      }}
                      className={`${pill} text-white`} style={{ background: 'var(--primary-action)' }}>
                {chosenHold ? holdAction(chosenHold) : ejecting ? 'Eject' : 'Mount'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </>
  );
}
