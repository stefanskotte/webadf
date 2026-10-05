'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { loadDisplayWasm, type DisplayWasm, type PreviewState } from '@/lib/display-wasm';
import {
  decodeLayout, encodeLayout, panelId, type ElementJson, type ElementName, type LayoutJson,
} from '@/lib/display-layout';
import {
  elementBox, hitTest, overlapping, panelHeight, placeElement, PANEL_W, statusLine,
} from '@/lib/display-editor-geometry';
import type { DeviceListItem } from '@/lib/queries';
import { HelpTip } from '@/components/help/help-tip';

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
// The SSD1306 modules on these boards are white-on-black; the preview matches.
const OLED_DARK = '#000000';
const OLED_LIT = '#ffffff';

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

/**
 * A decoded title with opt 0 is one line to the C side (layout_el_size); the
 * lines select only offers 1 and 2, so say 1 in the state the select shows.
 */
function normalise(l: LayoutJson): LayoutJson {
  return { ...l, elements: l.elements.map((e) => (e.id === 'title' && e.opt === 0 ? { ...e, opt: 1 } : e)) };
}

function defaultLayout(wasm: DisplayWasm, panel: LayoutJson['panel']): LayoutJson {
  return normalise(decodeLayout(wasm.defaultBlob(panelId(panel))));
}

/** What the board holds: its stored layout, or the built-in default for its panel when none is stored. */
function boardLayout(device: DeviceListItem, wasm: DisplayWasm): LayoutJson {
  if (device.displayLayout) {
    try { return normalise(decodeLayout(fromBase64(device.displayLayout))); } catch { /* unreadable: fall back to the default */ }
  }
  return defaultLayout(wasm, device.displayPanel);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DisplayEditor({ device }: { device: DeviceListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* The "?" is the toggle's sibling, never inside it: a button in a button
          is invalid, and opening help must not expand the editor. */}
      <span className="flex items-center gap-1 self-start" style={{ color: 'var(--muted)' }}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
                data-testid={`display-toggle-${device.id}`}
                className="text-[11px] font-semibold uppercase tracking-wide">
          {open ? '▾' : '▸'} Display
        </button>
        <HelpTip topic="display" />
      </span>
      {open && (device.displayLayouts
        ? <Editor device={device} />
        : (
          <span className="text-[12px]" style={{ color: 'var(--amber-text)' }}
                data-testid={`display-needs-fw-${device.id}`}>
            Needs firmware 1.7.1 or newer
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
  // Neither call is expected to throw, but a throw here would take the whole
  // device list down with it; it becomes a reason instead (Save disabled,
  // the last good frame shown).
  const reason = useMemo(() => {
    try { return wasm.validate(blob); } catch (e) { return `could not validate: ${message(e)}`; }
  }, [wasm, blob]);
  const rendered = useMemo((): { fb: Uint8Array | null; error: string | null } => {
    if (reason) return { fb: null, error: null };
    try {
      return { fb: wasm.render(previewState(preview, tick), panelId(layout.panel), blob), error: null };
    } catch (e) {
      return { fb: null, error: `could not render: ${message(e)}` };
    }
  }, [wasm, reason, preview, tick, layout.panel, blob]);
  const problem = reason ?? rendered.error;
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
  // Kept with its panel: another panel's frame is not a picture of this one.
  const lastGood = useRef<{ panel: LayoutJson['panel']; fb: Uint8Array } | null>(null);
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const css = getComputedStyle(c);
    const amber = css.getPropertyValue('--accent-amber').trim() || '#f5822e';

    const fb = rendered.fb;
    if (fb) lastGood.current = { panel: layout.panel, fb };
    else if (lastGood.current?.panel !== layout.panel) lastGood.current = null;
    const frame = fb ?? lastGood.current?.fb ?? null;
    ctx.clearRect(0, 0, c.width, c.height);
    if (frame) {
      ctx.globalAlpha = fb ? 1 : 0.35;
      // Lit pixels as the glass shows them: white on black, in either theme.
      // This canvas is a picture of the hardware, not page chrome.
      ctx.fillStyle = OLED_LIT;
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
  }, [layout, rendered, overlaps, rows]);

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
  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onTouchStart = (ev: TouchEvent) => {
      const t = ev.touches[0];
      const r = c.getBoundingClientRect();
      const px = ((t.clientX - r.left) * PANEL_W) / r.width;
      const py = ((t.clientY - r.top) * (c.height / ZOOM)) / r.height;
      if (hitTest(layoutRef.current.elements, px, py) >= 0) ev.preventDefault();
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
  // An edit made while the request is in flight is NOT what was sent: only a
  // layout still identical to the snapshot is marked clean (or replaced, for
  // a reset), so the refresh that follows cannot overwrite the newer edit.
  const save = () => {
    const sent = layout;
    return send({ panel: sent.panel, elements: sent.elements }, () => {
      if (layoutRef.current === sent) setDirty(false);
    });
  };
  const reset = () => {
    const sent = layout;
    return send({ reset: true, panel: sent.panel }, () => {
      if (layoutRef.current !== sent) return;
      setLayout(defaultLayout(wasm, sent.panel));
      setDirty(false);
    });
  };

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
                  onChange={(ev) => edit(defaultLayout(wasm, ev.target.value === '128x64' ? '128x64' : '128x32'))}>
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
                background: OLED_DARK,
                border: '1px solid var(--hairline-strong)',
                aspectRatio: `${PANEL_W} / ${rows}`,
                imageRendering: 'pixelated',
              }} />

      {problem && (
        <span style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }} data-testid={`display-reason-${id}`}>
          {problem}
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
        <button type="button" onClick={save} disabled={!!problem || busy || refreshing}
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
