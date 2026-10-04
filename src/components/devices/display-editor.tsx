'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { loadDisplayWasm, type DisplayWasm, type PreviewState } from '@/lib/display-wasm';
import {
  decodeLayout, encodeLayout, panelId, type ElementJson, type ElementName, type LayoutJson,
} from '@/lib/display-layout';
import {
  elementBox, hitTest, overlapping, panelHeight, placeElement, PANEL_W,
} from '@/lib/display-editor-geometry';
import type { DeviceListItem } from '@/lib/queries';

/**
 * The per-board OLED layout editor (spec 2026-10-04-oled-layouts §7 "Editor").
 *
 * The preview is NOT a drawing of the layout: it is the board's own renderer
 * (display.c, compiled to public/display.wasm) run on the layout being edited,
 * so what is on the canvas is the framebuffer the board would show. The editor
 * never decides validity either -- every change goes through the same C
 * validator the server and the board run.
 */

const ZOOM = 4;

const PREVIEWS = {
  ready: 'Ready',
  download: 'Downloading 64 %',
  writable: 'Mounted, writable',
  readonly: 'Mounted, read-only',
  long: 'Long title',
} as const;
type PreviewKey = keyof typeof PREVIEWS;

function previewState(key: PreviewKey, tick: number): PreviewState {
  const base: PreviewState = {
    status: 'ready', bars: 3, title: '', detail: '', showTrack: false, cyl: 0, maxCyl: 79,
    pct: -1, tick, writable: true, sync: 'synced',
  };
  const mounted = { ...base, status: 'loaded' as const, title: 'Workbench 3.1 Install', detail: 'disk 1 of 6', showTrack: true, cyl: 42 };
  switch (key) {
    case 'ready': return { ...base, title: 'no disk' };
    case 'download': return { ...base, status: 'download', pct: 64, title: 'Workbench 3.1 Install', detail: 'disk 1 of 6' };
    case 'writable': return mounted;
    case 'readonly': return { ...mounted, writable: false };
    case 'long': return { ...mounted, title: 'Gods v1.00 (1991-03-28)(Renegade)(Disk 1 of 2)', detail: 'disk 1 of 2' };
  }
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** What the board holds: its stored layout, or the built-in default for its panel when none is stored. */
function boardLayout(device: DeviceListItem, wasm: DisplayWasm): LayoutJson {
  if (device.displayLayout) {
    try { return decodeLayout(fromBase64(device.displayLayout)); } catch { /* unreadable: fall back to the default */ }
  }
  return decodeLayout(wasm.defaultBlob(panelId(device.displayPanel)));
}

/**
 * Both values of "did the board take it", never an absent line standing in
 * for one of them (the rejection wins: a board that refused a version has
 * handled it, so applied === version would read as success).
 */
function statusLine(device: DeviceListItem): { text: string; warn: boolean } {
  if (device.displayError) return { text: `The board rejected it: ${device.displayError}`, warn: true };
  if (device.displayAppliedVersion === device.displayVersion) return { text: 'Applied on the board', warn: false };
  return { text: 'Waiting for the board', warn: false };
}

export function DisplayEditor({ device }: { device: DeviceListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              data-testid={`display-toggle-${device.id}`}
              className="self-start text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: 'var(--muted)' }}>
        {open ? '▾' : '▸'} Display
      </button>
      {open && (device.displayLayouts
        ? <Editor device={device} />
        : (
          <span className="text-[12px]" style={{ color: 'var(--amber-text)' }}
                data-testid={`display-needs-fw-${device.id}`}>
            Needs firmware 1.7.0 or newer
          </span>
        ))}
    </div>
  );
}

function Editor({ device }: { device: DeviceListItem }) {
  const [wasm, setWasm] = useState<DisplayWasm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Module-level promise in display-wasm.ts: one fetch per page however
    // many cards open their editor.
    loadDisplayWasm().then((w) => { if (live) setWasm(w); },
      (e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, []);

  if (loadError) {
    return <span className="text-[12px]" style={{ color: 'var(--amber-text)' }}>Could not load the preview: {loadError}</span>;
  }
  if (!wasm) return <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Loading the preview…</span>;
  return <LoadedEditor device={device} wasm={wasm} />;
}

function LoadedEditor({ device, wasm }: { device: DeviceListItem; wasm: DisplayWasm }) {
  const id = device.id;
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();

  const [layout, setLayout] = useState<LayoutJson>(() => boardLayout(device, wasm));
  // Unsaved edits are never overwritten by a live update. Without edits, a
  // new stored layout (a save from another tab, a reset) replaces the view.
  const [dirty, setDirty] = useState(false);
  const boardKey = `${device.displayPanel}|${device.displayLayout ?? ''}`;
  const [seenBoardKey, setSeenBoardKey] = useState(boardKey);
  if (boardKey !== seenBoardKey) {
    setSeenBoardKey(boardKey);
    if (!dirty) setLayout(boardLayout(device, wasm));
  }

  const [preview, setPreview] = useState<PreviewKey>('writable');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // The lemming walks on the tick, as on the board.
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const [snap, setSnap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const blob = useMemo(() => encodeLayout(layout), [layout]);
  const reason = useMemo(() => wasm.validate(blob), [wasm, blob]);
  const overlaps = useMemo(() => overlapping(layout.elements), [layout]);
  const rows = panelHeight(layout.panel);

  const edit = useCallback((next: LayoutJson) => {
    setLayout(next);
    setDirty(true);
    setSaveError(null);
  }, []);

  // ----- drawing -----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The last framebuffer that rendered: an invalid layout cannot be rendered
  // (the renderer refuses it, as the board would), so the canvas keeps the
  // last good frame, faded, with the boxes outlined to show where things are.
  const lastGood = useRef<Uint8Array | null>(null);
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue('--ink').trim() || '#16232f';
    const amber = css.getPropertyValue('--accent-amber').trim() || '#f5822e';

    let fb: Uint8Array | null = null;
    if (!reason) {
      fb = wasm.render(previewState(preview, tick), panelId(layout.panel), blob);
      lastGood.current = fb;
    }
    const frame = fb ?? lastGood.current;
    ctx.clearRect(0, 0, c.width, c.height);
    if (frame) {
      ctx.globalAlpha = fb ? 1 : 0.35;
      ctx.fillStyle = ink;
      // SSD1306 page layout: byte (page * 128 + x), bit (y % 8).
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < PANEL_W; x++) {
          if (frame[(y >> 3) * PANEL_W + x] & (1 << (y & 7))) ctx.fillRect(x * ZOOM, y * ZOOM, ZOOM, ZOOM);
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = amber;
    ctx.lineWidth = 1;
    layout.elements.forEach((e, i) => {
      if (!e.visible || (fb && !overlaps.has(i))) return;
      const b = elementBox(e);
      ctx.strokeRect(b.x * ZOOM + 0.5, b.y * ZOOM + 0.5, b.w * ZOOM - 1, b.h * ZOOM - 1);
    });
  }, [wasm, layout, blob, reason, overlaps, preview, tick, rows]);

  // ----- drag -----
  // Panel coordinates from a pointer: the canvas is drawn at 4x but CSS
  // scales it to the card's width, so go through its on-screen rectangle.
  const toPanel = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      cx: ((clientX - r.left) * (PANEL_W * ZOOM)) / r.width,
      cy: ((clientY - r.top) * (rows * ZOOM)) / r.height,
    };
  };
  const drag = useRef<{ i: number; pointer: number; cx: number; cy: number; x: number; y: number } | null>(null);

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { cx, cy } = toPanel(ev.clientX, ev.clientY);
    const i = hitTest(layout.elements, cx / ZOOM, cy / ZOOM);
    if (i < 0) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const e = layout.elements[i];
    drag.current = { i, pointer: ev.pointerId, cx, cy, x: e.x, y: e.y };
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { cx, cy } = toPanel(ev.clientX, ev.clientY);
    const d = drag.current;
    if (!d || d.pointer !== ev.pointerId) {
      ev.currentTarget.style.cursor = hitTest(layout.elements, cx / ZOOM, cy / ZOOM) >= 0 ? 'grab' : 'default';
      return;
    }
    const e = layout.elements[d.i];
    const p = placeElement(e, d.x + Math.round((cx - d.cx) / ZOOM), d.y + Math.round((cy - d.cy) / ZOOM), layout.panel, snap);
    if (p.x === e.x && p.y === e.y) return;
    edit({ ...layout, elements: layout.elements.map((el, k) => (k === d.i ? { ...el, ...p } : el)) });
  };
  const endDrag = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointer === ev.pointerId) drag.current = null;
  };

  // A finger on the canvas scrolls the page, as anywhere else, UNLESS it
  // lands on an element: then the drag owns it. touch-action cannot express
  // "only over an element" (it is fixed when the touch starts), so a
  // non-passive touchstart cancels the scroll for exactly those touches.
  // Pointer events still fire, so the drag above is the same for both.
  const elementsRef = useRef(layout.elements);
  useEffect(() => { elementsRef.current = layout.elements; }, [layout.elements]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onTouchStart = (ev: TouchEvent) => {
      const t = ev.touches[0];
      const r = c.getBoundingClientRect();
      const px = ((t.clientX - r.left) * PANEL_W) / r.width;
      const py = ((t.clientY - r.top) * (c.height / ZOOM)) / r.height;
      if (hitTest(elementsRef.current, px, py) >= 0) ev.preventDefault();
    };
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    return () => c.removeEventListener('touchstart', onTouchStart);
  }, []);

  // ----- side list -----
  const setEl = (name: ElementName, patch: Partial<ElementJson>) => {
    edit({
      ...layout,
      elements: layout.elements.map((e) => {
        if (e.id !== name) return e;
        const n = { ...e, ...patch };
        // A new scale or size can push the box past an edge; pull it back in
        // (and onto even coordinates at 2x). Anything still too big is left
        // for the validator to name.
        return { ...n, ...placeElement(n, n.x, n.y, layout.panel, false) };
      }),
    });
  };
  const num = (v: string) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0;
  };

  // ----- save / reset -----
  async function send(body: unknown, after: () => void) {
    setBusy(true);
    setSaveError(null);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/devices/${id}/display`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
      } catch {
        setSaveError('Could not reach the server');
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { error?: string; reason?: string } | null;
        setSaveError(j?.reason ?? j?.error ?? `The server answered ${res.status}`);
        return;
      }
      after();
      // The status line reads the device row: the raised version shows as
      // "Waiting for the board" until the board acks.
      startRefresh(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }
  const save = () => send({ panel: layout.panel, elements: layout.elements }, () => setDirty(false));
  const reset = () => send({ reset: true, panel: layout.panel }, () => {
    setLayout(decodeLayout(wasm.defaultBlob(panelId(layout.panel))));
    setDirty(false);
  });

  const status = statusLine(device);
  const inputStyle = { background: 'var(--input-bg)', borderColor: 'var(--hairline)', color: 'var(--ink)' };
  // max-w-full: on a phone the card is ~130px wide, and a select sized to
  // "Mounted, read-only" otherwise runs past its edge.
  const field = 'max-w-full min-w-0 rounded border px-1 py-0.5 text-[11px]';

  return (
    <div className="flex min-w-0 flex-col gap-2 text-[12px]" data-testid={`display-editor-${id}`}>
      <span style={{ color: status.warn ? 'var(--amber-text)' : 'var(--muted)', overflowWrap: 'anywhere' }}
            data-testid={`display-status-${id}`}>
        {status.text}
      </span>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 max-w-full flex-wrap items-center gap-1" style={{ color: 'var(--muted)' }}>
          Panel
          <select value={layout.panel} className={field} style={inputStyle} data-testid={`display-panel-${id}`}
                  onChange={(ev) => edit(decodeLayout(wasm.defaultBlob(ev.target.value === '128x64' ? 1 : 0)))}>
            <option value="128x32">128×32</option>
            <option value="128x64">128×64</option>
          </select>
        </label>
        <label className="flex min-w-0 max-w-full flex-wrap items-center gap-1" style={{ color: 'var(--muted)' }}>
          Preview as
          <select value={preview} className={field} style={inputStyle} data-testid={`display-preview-${id}`}
                  onChange={(ev) => setPreview(ev.target.value as PreviewKey)}>
            {Object.entries(PREVIEWS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={snap} onChange={(ev) => setSnap(ev.target.checked)}
                 data-testid={`display-snap-${id}`} />
          Snap to 8 px
        </label>
      </div>

      <canvas ref={canvasRef} width={PANEL_W * ZOOM} height={rows * ZOOM}
              data-testid={`display-canvas-${id}`}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove}
              onPointerUp={endDrag} onPointerCancel={endDrag}
              className="block h-auto w-full rounded"
              style={{
                background: 'var(--panel-bg, var(--input-bg))',
                border: '1px solid var(--hairline-strong)',
                aspectRatio: `${PANEL_W} / ${rows}`,
                imageRendering: 'pixelated',
              }} />

      {reason && (
        <span style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }} data-testid={`display-reason-${id}`}>
          {reason}
        </span>
      )}

      <ul className="flex flex-col gap-1">
        {layout.elements.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label className="flex min-w-[5.5rem] items-center gap-1" style={{ color: 'var(--ink)' }}>
              <input type="checkbox" checked={e.visible} data-testid={`display-visible-${e.id}`}
                     onChange={(ev) => setEl(e.id, { visible: ev.target.checked })} />
              {e.id}
            </label>
            <select value={e.scale} className={field} style={inputStyle} data-testid={`display-scale-${e.id}`}
                    aria-label={`${e.id} scale`}
                    onChange={(ev) => setEl(e.id, { scale: ev.target.value === '2' ? 2 : 1 })}>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
            {(e.id === 'title' || e.id === 'detail' || e.id === 'download') && (
              <label className="flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                {e.id === 'download' ? 'bar' : 'width'}
                <input type="number" min={0} max={128} value={e.w} className={`${field} w-14`} style={inputStyle}
                       data-testid={`display-width-${e.id}`}
                       onChange={(ev) => setEl(e.id, { w: num(ev.target.value) })} />
              </label>
            )}
            {e.id === 'title' && (
              <label className="flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                lines
                <select value={e.opt} className={field} style={inputStyle} data-testid="display-lines-title"
                        onChange={(ev) => setEl(e.id, { opt: ev.target.value === '2' ? 2 : 1 })}>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={!!reason || busy || refreshing}
                data-testid={`display-save-${id}`}
                className="rounded-lg px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                style={{ background: 'var(--primary-action)', color: 'var(--on-dark)' }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={reset} disabled={busy || refreshing}
                data-testid={`display-reset-${id}`}
                className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
          Reset to default
        </button>
        {dirty && <span style={{ color: 'var(--muted)' }}>Unsaved changes</span>}
      </div>
      {saveError && (
        <span style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }} data-testid={`display-save-error-${id}`}>
          {saveError}
        </span>
      )}
    </div>
  );
}
