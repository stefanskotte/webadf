'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { loadDisplayWasm, type DisplayWasm } from '@/lib/display-wasm';
import { panelId } from '@/lib/display-layout';
import { panelHeight, PANEL_W } from '@/lib/display-editor-geometry';
import { paintFramebuffer } from '@/lib/display-paint';
import { liveDisplayState, liveDisplayText } from '@/lib/live-display';
import type { DeviceListItem } from '@/lib/queries';
import { fromBase64, BEZEL_EDGE } from './display-editor';
import { requestEject } from './device-actions';

const ZOOM = 2;
// The lemming's walk, at the editor's pace (display-editor.tsx).
const TICK_MS = 500;

/**
 * The front of the drive: slot, the board's OLED, two LEDs and the eject
 * button. The OLED is display.wasm -- the firmware's own renderer -- drawing
 * the board's stored layout with what the board last reported
 * (live-display.ts), so it is the board's screen, not a picture of one.
 *
 * `drawerOpen`: the Display drawer is out underneath. The bezel's face dims
 * and blurs (and goes inert, so its eject cannot be pressed through the blur)
 * and its bottom corners square off to meet the drawer.
 */
export function DriveBezel({ device, online, drawerOpen, onOpenDisplay }: {
  device: DeviceListItem; online: boolean; drawerOpen: boolean; onOpenDisplay: () => void;
}) {
  const router = useRouter();
  const [wasm, setWasm] = useState<DisplayWasm | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadDisplayWasm().then((w) => { if (live) setWasm(w); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  // A board that is not answering has a lemming that is not walking, as far
  // as anyone here can tell -- so it stands still.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!online) return;
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [online]);

  const state = liveDisplayState(device, online, tick);
  const rows = panelHeight(device.displayPanel);
  const panel = panelId(device.displayPanel);
  // The stored layout, when it decodes and validates; otherwise the panel's
  // default, which is what the board itself falls back to.
  const blob = useMemo(() => {
    if (!wasm || !device.displayLayout) return null;
    try {
      const b = fromBase64(device.displayLayout);
      return wasm.validate(b) === null ? b : null;
    } catch { return null; }
  }, [wasm, device.displayLayout]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !wasm) return;
    ctx.clearRect(0, 0, PANEL_W * ZOOM, rows * ZOOM);
    try {
      paintFramebuffer(ctx, wasm.render(state, panel, blob), rows, ZOOM, '#ffffff');
    } catch { /* a render that throws leaves the glass dark rather than the page broken */ }
  });

  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const ejectable = device.desiredSha256 !== null || device.mountedSha256 !== null;
  async function eject() {
    setBusy(true);
    try {
      // The card reads "Ejecting…" once the refresh lands -- desired has
      // changed, actual has not yet.
      if (await requestEject(device.id)) start(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const words = failed ? 'Display preview unavailable' : liveDisplayText(state);
  const face = drawerOpen ? { opacity: 0.4, filter: 'blur(1.5px)' } : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3 p-2 lg:p-3"
         data-testid={`device-bezel-${device.id}`}
         style={{
           background: `linear-gradient(#2c3137, ${BEZEL_EDGE})`,
           borderRadius: drawerOpen ? '10px 10px 0 0' : '10px',
           boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.08), 0 2px 0 rgb(0 0 0 / 0.25)',
         }}>
      <div aria-hidden className="h-2 rounded-full transition-[opacity,filter]"
           style={{ background: '#07090b', boxShadow: 'inset 0 2px 2px rgb(0 0 0 / 0.9), 0 1px 0 rgb(255 255 255 / 0.07)', ...face }} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 transition-[opacity,filter]"
           style={face} inert={drawerOpen}>
        {/* The glass opens the editor too: it is the thing being changed. */}
        <button type="button" onClick={onOpenDisplay} aria-label={`Change display — showing: ${words}`}
                data-testid={`device-oled-${device.id}`} data-oled={words}
                className="block min-w-0 flex-[1_1_9rem] cursor-pointer rounded-[3px]"
                style={{ maxWidth: PANEL_W * ZOOM, boxShadow: '0 0 0 3px #0d0f12, 0 0 0 4px #3a4048' }}>
          <canvas ref={canvasRef} width={PANEL_W * ZOOM} height={rows * ZOOM}
                  className="block h-auto w-full rounded-[3px]"
                  style={{ background: '#000000', aspectRatio: `${PANEL_W} / ${rows}`, imageRendering: 'pixelated' }} />
        </button>
        <div className="ml-auto flex min-w-0 items-center gap-2 lg:gap-3">
          <Led on={online} color="#5fd18b" label="ON" />
          <Led on={device.mountedSha256 !== null} color="#f5822e" label="DISK" />
          <button type="button" onClick={eject} disabled={!ejectable || busy || pending}
                  data-testid={`eject-${device.id}`}
                  aria-label={busy || pending ? 'Ejecting…' : 'Eject'}
                  className="h-6 rounded-[5px] px-2.5 text-[9px] font-semibold tracking-[0.08em] disabled:opacity-40"
                  style={{
                    background: 'linear-gradient(#4a5058, #353a41)', color: '#c9d0d6',
                    boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.12), 0 1px 0 #000',
                  }}>
            {busy || pending ? '…' : 'EJECT'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A lit or dark LED. Decoration: the card's badge and words carry the facts. */
function Led({ on, color, label }: { on: boolean; color: string; label: string }) {
  return (
    <span aria-hidden className="flex flex-col items-center gap-1">
      <span className="h-2 w-2 rounded-full"
            style={{ background: on ? color : '#3a4048', boxShadow: on ? `0 0 8px ${color}` : undefined }} />
      <span className="text-[8px] font-semibold tracking-[0.1em]" style={{ color: '#8a949e' }}>{label}</span>
    </span>
  );
}
