'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadDisplayWasm, type DisplayWasm } from '@/lib/display-wasm';
import { panelId, stripRotation } from '@/lib/display-layout';
import { panelHeight, PANEL_W } from '@/lib/display-editor-geometry';
import { paintFramebuffer } from '@/lib/display-paint';
import { liveDisplayState, liveDisplayText } from '@/lib/live-display';
import type { DeviceListItem } from '@/lib/queries';
import { fromBase64 } from './display-editor';
import { artHeight, ART_W, GLASS_W } from './drive-art';

const ZOOM = 2;
// The lemming's walk, at the editor's pace (display-editor.tsx).
const TICK_MS = 500;

/**
 * The board's own screen, drawn over `DriveArt` (spec §3). The OLED is display.wasm -- the firmware's own renderer --
 * drawing the board's stored layout with what the board last reported (live-display.ts), so it is the board's
 * screen, not a picture of one. It is the button that opens the display editor, placed in percentages of the art's
 * viewBox (left 18, top 11, GLASS_W wide; drive-art.tsx sizes the case around it) so it scales with the SVG.
 */
export function DriveGlass({ device, online, onOpenDisplay }: {
  device: DeviceListItem; online: boolean; onOpenDisplay: (from: HTMLElement) => void;
}) {
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
  // default, which is what the board itself falls back to. Drawn upright at
  // Rotation 180, as the editor's preview is: the turn is how the panel is
  // mounted, and a picture of it upside down only reads as upside down here.
  const blob = useMemo(() => {
    if (!wasm || !device.displayLayout) return null;
    try {
      const b = fromBase64(device.displayLayout);
      return wasm.validate(b) === null ? stripRotation(b) : null;
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

  const words = failed ? 'Display preview unavailable' : liveDisplayText(state);
  const artH = artHeight(rows === 64);
  return (
    <button type="button" onClick={(e) => onOpenDisplay(e.currentTarget)} aria-haspopup="dialog"
            aria-label={`Change display — showing: ${words}`}
            data-testid={`device-oled-${device.id}`} data-oled={words}
            className="absolute box-border block cursor-pointer max-sm:before:absolute max-sm:before:-inset-y-2 max-sm:before:inset-x-0 max-sm:before:content-[''] rounded-[4px] bg-[#1C1B18] px-1 py-px shadow-[inset_0_0_0_1px_rgb(255_255_255/.06)] transition-transform hover:-translate-y-px hover:ring-2 hover:ring-[#EE8A2A] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:ring-0"
            style={{ left: `${(18 / ART_W) * 100}%`, top: `${(11 / artH) * 100}%`, width: `${(GLASS_W / ART_W) * 100}%` }}>
      <canvas ref={canvasRef} width={PANEL_W * ZOOM} height={rows * ZOOM}
              className="block h-auto w-full"
              style={{ background: '#000000', aspectRatio: `${PANEL_W} / ${rows}`, imageRendering: 'pixelated' }} />
    </button>
  );
}
