'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Nfc } from 'lucide-react';
import { formatTagUid, writeFailureText, type NfcWriteStatus } from '@/lib/nfc/rules';

/** A board with a reader present, as the page loaded it. */
export type FobDevice = { id: string; name: string };
/** One disk the tag could carry. `diskNo` labels it as the title page does. */
export type FobDisk = { id: string; diskNo: number };
/** What the library grid needs to draw the button: null when the org has no reader. */
export type FobContext = { devices: FobDevice[]; disksByGame: Record<string, FobDisk[]> } | null;

// The request's own life on the board (NFC_WRITE_TTL_MS). The countdown is
// the person's clock; the server's expiry is what actually ends the wait.
const WAIT_MS = 120_000;
const POLL_MS = 1000;
// How long past zero the dialog keeps asking before it stops believing the
// server will ever say "expired" (a dropped connection, a sleeping laptop).
const GRACE_MS = 10_000;

type Phase =
  | { k: 'choose' }
  | { k: 'starting' }
  | { k: 'waiting'; deviceId: string; deviceName: string; seq: number; deadline: number }
  | { k: 'written'; uid: string | null }
  | { k: 'failed'; text: string };

/**
 * The fob button: write a disk onto an NFC tag, so tapping that tag later
 * mounts it (spec 2026-09-25). The web half of what `pnpm nfc:write` does.
 *
 * Drawn only when the org has a board whose reader is present -- the page
 * decides that on the server and passes `devices`; this never fetches just
 * to find out whether it should exist.
 *
 * A request left armed is a board that will write the NEXT tag anyone taps,
 * for up to two minutes. So every way out of the wait -- Cancel, Escape,
 * closing, navigating away (unmount) -- withdraws it, and only THIS seq: a
 * newer request (the CLI, another tab) is left alone by the server.
 */
export function FobButton({ testId, title, disks, devices }: {
  testId: string;
  /** The title the disk belongs to, for the accessible name and the dialog heading. */
  title: string;
  disks: FobDisk[];
  devices: FobDevice[];
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: 'choose' });
  const [diskId, setDiskId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const titleId = useId();

  // The armed request, if any. A ref, not state: the unmount cleanup and the
  // close path must see the CURRENT one, not the one captured at render.
  const armed = useRef<{ deviceId: string; seq: number } | null>(null);
  // Bumped on every close, so a POST or poll that answers after the dialog
  // closed knows it is stale.
  const generation = useRef(0);

  function withdraw() {
    const a = armed.current;
    armed.current = null;
    if (!a) return;
    // keepalive: the page may be unloading (navigation away), and a dropped
    // cancel leaves the board armed until its own expiry.
    void fetch('/api/nfc/write', {
      method: 'DELETE', keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a),
    }).catch(() => {});
  }

  function close() {
    withdraw();
    generation.current += 1;
    setOpen(false);
    setPhase({ k: 'choose' });
  }

  async function start(disk: string, device: string) {
    const gen = generation.current;
    setPhase({ k: 'starting' });
    let res: Response;
    try {
      res = await fetch('/api/nfc/write', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diskId: disk, deviceId: device }),
      });
    } catch {
      if (gen === generation.current) setPhase({ k: 'failed', text: 'Could not reach the server.' });
      return;
    }
    const body = await res.json().catch(() => null) as
      { seq?: number; deviceId?: string; deviceName?: string; error?: string } | null;
    if (!res.ok || !body?.seq || !body.deviceId) {
      if (gen !== generation.current) return;
      setPhase({
        k: 'failed',
        text: body?.error === 'no_reader'
          ? 'That board no longer reports an NFC reader.'
          : body?.error === 'not_found'
            ? 'That disk or board is no longer in your library.'
            : 'Could not start the write.',
      });
      return;
    }
    armed.current = { deviceId: body.deviceId, seq: body.seq };
    // Closed while the POST was in flight: the board is armed for nobody.
    if (gen !== generation.current) { withdraw(); return; }
    const t = Date.now();
    setNow(t);
    setPhase({ k: 'waiting', deviceId: body.deviceId, deviceName: body.deviceName ?? 'the board', seq: body.seq, deadline: t + WAIT_MS });
  }

  function onOpen(e: React.MouseEvent) {
    // Inside the library card's <a href>: must not navigate or start a drag.
    e.preventDefault();
    e.stopPropagation();
    generation.current += 1;
    const onlyDisk = disks.length === 1 ? disks[0].id : null;
    const onlyDevice = devices.length === 1 ? devices[0].id : null;
    setDiskId(onlyDisk);
    setDeviceId(onlyDevice);
    setOpen(true);
    // Nothing to choose: go straight to "tap a tag".
    if (onlyDisk && onlyDevice) void start(onlyDisk, onlyDevice);
    else setPhase({ k: 'choose' });
  }

  // Poll the request and tick the countdown while waiting.
  const waiting = phase.k === 'waiting' ? phase : null;
  useEffect(() => {
    if (!waiting) return;
    const gen = generation.current;
    let inFlight = false;
    const id = window.setInterval(async () => {
      const t = Date.now();
      setNow(t);
      if (inFlight) return;
      if (t > waiting.deadline + GRACE_MS) {
        withdraw();
        setPhase({ k: 'failed', text: 'Timed out — no tag was written.' });
        return;
      }
      inFlight = true;
      try {
        const res = await fetch(`/api/nfc/write?deviceId=${encodeURIComponent(waiting.deviceId)}&seq=${waiting.seq}`,
          { cache: 'no-store' });
        if (!res.ok || gen !== generation.current) return;
        const s = await res.json() as NfcWriteStatus;
        if (gen !== generation.current || s.state === 'waiting') return;
        // Answered, replaced or expired: nothing is armed for us any more.
        armed.current = null;
        if (s.state === 'ok') setPhase({ k: 'written', uid: s.uid });
        else if (s.state === 'failed') setPhase({ k: 'failed', text: writeFailureText(s.reason) });
        else if (s.state === 'superseded') setPhase({ k: 'failed', text: 'Replaced by another write request.' });
        else setPhase({ k: 'failed', text: 'Timed out — no tag was written.' });
      } catch {
        // A dropped poll is retried on the next tick; the grace above ends it.
      } finally {
        inFlight = false;
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request, not the object identity
  }, [waiting?.deviceId, waiting?.seq]);

  // Escape closes (and so withdraws), as on every dialog here. The overlay
  // handles it too, for focus inside the dialog; this catches focus left
  // on the page behind.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close only reads refs and setters
  }, [open]);

  // Unmount while armed (a client-side navigation away mid-wait) withdraws
  // too. A full unload -- closing the tab, a reload, typing a URL -- runs no
  // React cleanup at all, so pagehide covers that; withdraw's keepalive is
  // what lets the DELETE outlive the page.
  useEffect(() => {
    window.addEventListener('pagehide', withdraw);
    return () => { window.removeEventListener('pagehide', withdraw); withdraw(); };
  }, []);

  const trigger = (
    <button
      type="button"
      data-testid={testId}
      aria-label={`Write ${title} to an NFC tag`}
      title="Write to an NFC tag"
      onClick={onOpen}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="shrink-0 rounded p-1 transition-colors hover:bg-[var(--glass-strong)] hover:text-[var(--ink)]"
      style={{ color: 'var(--faint)' }}
    >
      <Nfc size={14} strokeWidth={1.75} aria-hidden />
    </button>
  );
  if (!open) return trigger;

  const chosenDisk = disks.find((d) => d.id === diskId);
  const heading = disks.length > 1 && chosenDisk ? `${title} — Disk ${chosenDisk.diskNo}` : title;
  const remaining = waiting ? Math.max(0, waiting.deadline - now) : 0;
  const mmss = `${Math.floor(remaining / 60_000)}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, '0')}`;
  const uid = phase.k === 'written' ? formatTagUid(phase.uid) : null;
  const pill = 'rounded-full px-4 py-1.5 text-[12.5px] font-semibold disabled:opacity-50';
  const choice = (on: boolean) => ({
    className: 'rounded-lg px-3 py-1.5 text-[12.5px] font-semibold',
    style: on
      ? { background: 'var(--primary-action)', color: 'white' }
      : { background: 'var(--glass-strong)', color: 'var(--ink)' },
  });

  // PORTALLED, like DeleteDiskDialog and for the same reason: a library card
  // sets backdrop-filter, which would make it the containing block of this
  // `fixed inset-0` overlay. Events still bubble through the React tree to
  // the card's link and drag listeners, so the overlay stops them -- but
  // does not preventDefault, which the choice buttons do not need either.
  return (
    <>
      {trigger}
      {createPortal((
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgb(11 18 28 / 0.55)' }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="fob-dialog"
               className="glass-card flex max-h-full w-full max-w-[440px] flex-col gap-3 overflow-y-auto p-6 text-left">
            <h2 id={titleId} className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>
              Write to an NFC tag
            </h2>
            <p className="break-words text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{heading}</p>

            {phase.k === 'choose' && (
              <>
                {disks.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Which disk?</span>
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Disk">
                      {disks.map((d) => (
                        <button key={d.id} type="button" data-testid={`fob-disk-${d.id}`}
                                aria-pressed={diskId === d.id} onClick={() => setDiskId(d.id)}
                                {...choice(diskId === d.id)}>
                          Disk {d.diskNo}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {devices.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Which board?</span>
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Board">
                      {devices.map((d) => (
                        <button key={d.id} type="button" data-testid={`fob-device-${d.id}`}
                                aria-pressed={deviceId === d.id} onClick={() => setDeviceId(d.id)}
                                {...choice(deviceId === d.id)}>
                          <span className="break-all">{d.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button type="button" onClick={close} className={pill} style={{ color: 'var(--muted)' }}>Cancel</button>
                  <button type="button" data-testid="fob-start" autoFocus
                          disabled={!diskId || !deviceId}
                          onClick={() => { if (diskId && deviceId) void start(diskId, deviceId); }}
                          className={`${pill} text-white`} style={{ background: 'var(--primary-action)' }}>
                    Start
                  </button>
                </div>
              </>
            )}

            {phase.k === 'starting' && (
              <>
                <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Arming the reader…</p>
                <div className="mt-2 flex justify-end">
                  <button type="button" data-testid="fob-cancel" onClick={close} autoFocus className={pill}
                          style={{ color: 'var(--muted)' }}>Cancel</button>
                </div>
              </>
            )}

            {waiting && (
              <>
                {/* A tag already lying on the reader is never written (firmware
                    1.3.1): it has to leave and come back, so say so up front. */}
                <p className="text-[13px]" style={{ color: 'var(--ink)' }} data-testid="fob-waiting">
                  Tap a tag on <strong className="break-all">{waiting.deviceName}</strong> (lift any tag already on the reader first)
                </p>
                <p className="font-mono text-[22px] tabular-nums" style={{ color: 'var(--ink)' }}
                   data-testid="fob-countdown" aria-live="off">{mmss}</p>
                <div className="flex justify-end">
                  <button type="button" data-testid="fob-cancel" onClick={close} autoFocus className={pill}
                          style={{ color: 'var(--muted)' }}>Cancel</button>
                </div>
              </>
            )}

            {(phase.k === 'written' || phase.k === 'failed') && (
              <>
                <p role="status" data-testid="fob-result" className="text-[14px] font-semibold"
                   style={{ color: phase.k === 'written' ? 'var(--ink)' : 'var(--danger-fg)' }}>
                  {phase.k === 'written'
                    ? `Tag written ✓${uid ? ` (${uid})` : ''}`
                    : phase.text}
                </p>
                <div className="flex justify-end">
                  <button type="button" data-testid="fob-close" onClick={close} autoFocus className={pill}
                          style={{ color: 'var(--muted)' }}>{phase.k === 'written' ? 'Done' : 'Close'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      ), document.body)}
    </>
  );
}
