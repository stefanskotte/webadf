'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { loadDisplayWasm, type DisplayWasm, type PreviewState } from '@/lib/display-wasm';
import {
  decodeLayout, encodeLayout, NFC_ELEMENT_FIRMWARE, panelId, ROTATION_FIRMWARE,
  STATUS_ICON_FIRMWARE, STATUS_OPT, type ElementJson, type ElementName, type LayoutJson,
} from '@/lib/display-layout';
import {
  elementBox, hitTest, overlapping, panelHeight, placeElement, PANEL_W, statusLine,
} from '@/lib/display-editor-geometry';
import type { DeviceListItem } from '@/lib/queries';
import { Modal } from '@/components/ui/modal';
import { ELEMENT_LOOK } from '@/lib/display-elements';
import { paintFramebuffer } from '@/lib/display-paint';

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
  armed: 'Tag write armed',
  // The start-up screens use the built-in layout, but show the status icon
  // when this layout's status element chose it (display.c display_layout_for).
  connecting: 'Connecting',
  error: 'Error',
} as const;
type PreviewKey = keyof typeof PREVIEWS;

/** `reader`: the NFC icon's state in every preview but 'armed' -- the board's own reported reader. */
function previewState(key: PreviewKey, tick: number, reader: PreviewState['nfc']): PreviewState {
  const base: PreviewState = {
    status: 'ready', bars: 3, title: '', detail: '', showTrack: false, side: 0, cyl: 0, maxCyl: 79,
    pct: -1, tick, writable: true, sync: 'synced', nfc: reader,
  };
  // Cylinder 42, side 1: the counter reads "42" + the up arrow + "79" (side 0 is the down arrow).
  const mounted = { ...base, status: 'loaded' as const, title: 'Workbench 3.1 Install', detail: 'disk 1 of 6', showTrack: true, side: 1 as const, cyl: 42 };
  switch (key) {
    case 'ready': return { ...base, title: 'no disk' };
    case 'download': return { ...base, status: 'download', pct: 64, title: 'Workbench 3.1 Install', detail: 'disk 1 of 6' };
    case 'writable': return mounted;
    case 'readonly': return { ...mounted, writable: false };
    case 'long': return { ...mounted, title: 'Gods v1.00 (1991-03-28)(Renegade)(Disk 1 of 2)', detail: 'disk 1 of 2' };
    // What main.c shows while a tag write waits: the disk on the title line,
    // nfc_ui.h NFC_UI_ARMED_DETAIL below it, and the icon inverted.
    case 'armed': return { ...mounted, title: 'Turrican', detail: 'Tap tag to write', nfc: 'armed' };
    // main.c's own strings for these screens.
    case 'connecting': return { ...base, status: 'wifi', bars: 1, title: 'Connecting', detail: 'HomeNet' };
    case 'error': return { ...base, status: 'error', bars: -1, title: 'no route' };
  }
}

/**
 * Where the NFC icon starts when a layout does not list it yet: on the status
 * row between the status word (14..61) and the write glyph (110), on either
 * panel. Hidden, so adding it to the list changes nothing on the glass.
 */
const NFC_START: ElementJson = { id: 'nfc', visible: false, scale: 1, x: 100, y: 0, w: 0, opt: 0 };

/**
 * The 'nfc' element is in the list exactly when the board's firmware knows it
 * (1.10.0+): appended, hidden, to a layout saved before it existed (and to the
 * built-in defaults, which never list it); removed for an older board, which
 * would refuse the whole layout over it.
 */
function withNfc(l: LayoutJson, supported: boolean): LayoutJson {
  const has = l.elements.some((e) => e.id === 'nfc');
  if (supported && !has) return { ...l, elements: [...l.elements, NFC_START] };
  if (!supported && has) return { ...l, elements: l.elements.filter((e) => e.id !== 'nfc') };
  return l;
}

/** A turn only for a board that can make it; an older one is sent the upright layout. */
function withRotation(l: LayoutJson, supported: boolean): LayoutJson {
  return supported ? l : turned(l, 0);
}

/**
 * The status element as the board will draw it: for a board that has the icon
 * (1.15.0+) the word or the icon, and any other opt (a later firmware's) as the
 * word it draws; for an older board, which refuses any opt but the word, the word.
 */
function withStatusStyle(l: LayoutJson, iconOk: boolean): LayoutJson {
  return {
    ...l,
    elements: l.elements.map((e) => (e.id === 'status' && e.opt !== STATUS_OPT.word && !(iconOk && e.opt === STATUS_OPT.icon)
      ? { ...e, opt: STATUS_OPT.word } : e)),
  };
}

type BoardCaps = Pick<DeviceListItem, 'displayNfcElement' | 'displayStatusIcon' | 'displayRotation'>;

/** What a board can be sent: the nfc element, the status icon and a turn only where its firmware has them. */
function forBoard(l: LayoutJson, device: BoardCaps): LayoutJson {
  return withRotation(
    withStatusStyle(withNfc(l, device.displayNfcElement), device.displayStatusIcon),
    device.displayRotation,
  );
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/**
 * A decoded title with opt 0 is one line to the C side (layout_el_size); the
 * lines select only offers 1 and 2, so say 1 in the state the select shows.
 */
function normalise(l: LayoutJson): LayoutJson {
  return { ...l, elements: l.elements.map((e) => (e.id === 'title' && e.opt === 0 ? { ...e, opt: 1 } : e)) };
}

function defaultLayout(wasm: DisplayWasm, panel: LayoutJson['panel'], device: DeviceListItem): LayoutJson {
  return forBoard(normalise(decodeLayout(wasm.defaultBlob(panelId(panel)))), device);
}

/** What the board holds: its stored layout, or the built-in default for its panel when none is stored. */
function boardLayout(device: DeviceListItem, wasm: DisplayWasm): LayoutJson {
  if (device.displayLayout) {
    try {
      return forBoard(normalise(decodeLayout(fromBase64(device.displayLayout))), device);
    } catch { /* unreadable: fall back to the default */ }
  }
  return defaultLayout(wasm, device.displayPanel, device);
}

/** `l` turned `rotation` (0 or absent: upright, with no rotation key, the shape older layouts have). */
function turned(l: LayoutJson, rotation: LayoutJson['rotation']): LayoutJson {
  const upright = { ...l };
  delete upright.rotation;
  return rotation === 180 ? { ...upright, rotation: 180 } : upright;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The Board display modal (Devices spec §10). Open state is the caller's (drive-front.tsx), which mounts this only
 * while open: closing -- Cancel, the X, Escape, the backdrop -- unmounts the editor, which is what discards unsaved
 * edits: nothing is sent, and the next open starts from the board's stored layout again. Reset is separate: it
 * asks the server to put the board back to the built-in default.
 */
export function DisplayEditor({ device, onOpenChange, finalFocus }: {
  device: DeviceListItem; onOpenChange: (open: boolean) => void; finalFocus?: RefObject<HTMLElement | null>;
}) {
  if (!device.displayLayouts) {
    return (
      <Shell device={device} onOpenChange={onOpenChange} finalFocus={finalFocus} dismissible
             footer={<CloseButton id={device.id} onClick={() => onOpenChange(false)}>Close</CloseButton>}>
        <p className="px-6 py-5 text-[13px]" style={{ color: 'var(--amber-text)' }}
           data-testid={`display-needs-fw-${device.id}`}>
          Needs firmware 1.7.1 or newer
        </p>
      </Shell>
    );
  }
  return <Editor device={device} onOpenChange={onOpenChange} finalFocus={finalFocus} />;
}

/** `Modal` with the display modal's fixed header. */
function Shell({ device, onOpenChange, finalFocus, dismissible, badge, status, footer, children }: {
  device: DeviceListItem; onOpenChange: (open: boolean) => void; finalFocus?: RefObject<HTMLElement | null>;
  dismissible: boolean; badge?: ReactNode; status?: { text: string; warn: boolean };
  footer: ReactNode; children: ReactNode;
}) {
  return (
    <Modal open onOpenChange={onOpenChange} width={940} testId={`display-drawer-${device.id}`}
           closeTestId={`display-close-${device.id}`} dismissible={dismissible} finalFocus={finalFocus}
           title="Board display" badge={badge}
           subtitle={(
             <>
               {`Choose what ${device.name}’s screen shows. Changes are sent to the board when you save.`}
               {status && (
                 <span role="status" className="mt-1 block text-[12px]" data-testid={`display-status-${device.id}`}
                       style={{ color: status.warn ? 'var(--amber-text)' : 'var(--muted)', overflowWrap: 'anywhere' }}>
                   {status.text}
                 </span>
               )}
             </>
           )}
           footer={<div className="flex w-full flex-wrap items-center gap-2.5">{footer}</div>}>
      {children}
    </Modal>
  );
}

const SECONDARY_BUTTON = 'min-h-[38px] whitespace-nowrap rounded-[10px] border px-3.5 text-[13px] font-medium disabled:opacity-50';

function CloseButton({ id, onClick, disabled, children }: {
  id: string; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  return (
    <>
      <span className="min-w-0 flex-1" />
      <button type="button" onClick={onClick} disabled={disabled} data-testid={`display-cancel-${id}`}
              className={SECONDARY_BUTTON}
              style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
        {children}
      </button>
    </>
  );
}

/**
 * A WAI-ARIA radiogroup: one tab stop on the checked radio, arrows move the choice and skip disabled radios. While
 * a request runs the radios are `aria-disabled`, never `disabled`, so focus does not drop to the body and the
 * input is ignored; `disabled` is for a radio that cannot be chosen at all.
 */
function Radios<V extends string | number>({ label, testId, value, options, onChange, busy, className, itemClass }: {
  label: string; testId: string; value: V;
  options: { value: V; label: string; testId: string; disabled?: boolean }[];
  onChange: (v: V) => void; busy: boolean; className: string; itemClass: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = options.filter((o) => !o.disabled);
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (busy) return;
    const at = enabled.findIndex((o) => o.value === value);
    if (at < 0 || enabled.length < 2) return;
    const target = enabled[(at + dir + enabled.length) % enabled.length];
    ref.current?.querySelector<HTMLElement>(`[data-testid="${target.testId}"]`)?.focus();
    onChange(target.value);
  }
  // The tab stop sits on the checked radio, or on the first enabled one when the checked one is disabled.
  const stop = enabled.some((o) => o.value === value) ? value : enabled[0]?.value;
  return (
    <div ref={ref} role="radiogroup" aria-label={label} data-testid={testId} data-value={String(value)}
         onKeyDown={onKeyDown} className={className}>
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={checked}
                  tabIndex={o.value === stop ? 0 : -1} disabled={o.disabled} aria-disabled={busy || undefined}
                  data-testid={o.testId}
                  onClick={() => { if (!busy && !checked) onChange(o.value); }}
                  className={itemClass}
                  style={checked ? { background: 'var(--ink)', color: 'var(--surface)', borderColor: 'var(--ink)' }
                    : { background: 'var(--surface)', color: 'var(--ink)', borderColor: 'var(--line)' }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Editor({ device, onOpenChange, finalFocus }: {
  device: DeviceListItem; onOpenChange: (open: boolean) => void; finalFocus?: RefObject<HTMLElement | null>;
}) {
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

  if (!wasm) {
    return (
      <Shell device={device} onOpenChange={onOpenChange} finalFocus={finalFocus} dismissible
             footer={<CloseButton id={device.id} onClick={() => onOpenChange(false)}>Cancel</CloseButton>}>
        {loadError
          ? <p className="px-6 py-5 text-[12px]" style={{ color: 'var(--amber-text)' }}>Could not load the preview: {loadError}</p>
          : <p className="px-6 py-5 text-[12px]" style={{ color: 'var(--muted)' }}>Loading the preview…</p>}
      </Shell>
    );
  }
  return <LoadedEditor device={device} wasm={wasm} onOpenChange={onOpenChange} finalFocus={finalFocus} />;
}

function LoadedEditor({ device, wasm, onOpenChange, finalFocus }: {
  device: DeviceListItem; wasm: DisplayWasm; onOpenChange: (open: boolean) => void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const onCancel = () => onOpenChange(false);
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
  const reader: PreviewState['nfc'] = device.nfcReader === 'present' ? 'present' : 'absent';
  const nfcOk = device.displayNfcElement;
  const iconOk = device.displayStatusIcon;
  const rotateOk = device.displayRotation;
  const rotation = layout.rotation === 180 ? 180 : 0;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // The lemming walks and the status icon blinks on the tick, at the
    // board's own rate (main.c LEMMING_STEP_MS, 120 ms).
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const [snap, setSnap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const blob = useMemo(() => encodeLayout(layout), [layout]);
  // The preview is always upright (the layout as read on a correctly mounted
  // panel); only the blob that is validated and sent carries the rotation.
  const previewBlob = useMemo(() => encodeLayout(turned(layout, 0)), [layout]);
  // Neither call is expected to throw, but a throw here would take the whole
  // device list down with it; it becomes a reason instead (Save disabled,
  // the last good frame shown).
  const reason = useMemo(() => {
    try { return wasm.validate(blob); } catch (e) { return `could not validate: ${message(e)}`; }
  }, [wasm, blob]);
  const rendered = useMemo((): { fb: Uint8Array | null; error: string | null } => {
    if (reason) return { fb: null, error: null };
    try {
      return { fb: wasm.render(previewState(preview, tick, reader), panelId(layout.panel), previewBlob), error: null };
    } catch (e) {
      return { fb: null, error: `could not render: ${message(e)}` };
    }
  }, [wasm, reason, preview, tick, reader, layout.panel, previewBlob]);
  const problem = reason ?? rendered.error;
  const overlaps = useMemo(() => overlapping(layout.elements), [layout]);
  const rows = panelHeight(layout.panel);

  const edit = useCallback((next: LayoutJson) => {
    setLayout(next);
    setDirty(true);
    setSaveError(null);
  }, []);

  // ----- drawing -----
  // The canvas lives in the modal's portal, which mounts a render after this component: a plain ref is still null
  // when the effects below first run, so the element is also kept in state and the effects wait for it.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const setCanvas = useCallback((c: HTMLCanvasElement | null) => { canvasRef.current = c; setCanvasEl(c); }, []);
  // The last framebuffer that rendered: an invalid layout cannot be rendered
  // (the renderer refuses it, as the board would), so the canvas keeps the
  // last good frame, faded, with the boxes outlined to show where things are.
  // Kept with its panel: another panel's frame is not a picture of this one.
  const lastGood = useRef<{ panel: LayoutJson['panel']; fb: Uint8Array } | null>(null);
  useEffect(() => {
    const c = canvasEl;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const css = getComputedStyle(c);
    const amber = css.getPropertyValue('--accent-amber').trim() || '#B5541A';

    const fb = rendered.fb;
    if (fb) lastGood.current = { panel: layout.panel, fb };
    else if (lastGood.current?.panel !== layout.panel) lastGood.current = null;
    const frame = fb ?? lastGood.current?.fb ?? null;
    ctx.clearRect(0, 0, c.width, c.height);
    if (frame) {
      ctx.globalAlpha = fb ? 1 : 0.35;
      // Lit pixels as the glass shows them: white on black, in either theme.
      // This canvas is a picture of the hardware, not page chrome.
      paintFramebuffer(ctx, frame, rows, ZOOM, OLED_LIT);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = amber;
    ctx.lineWidth = 1;
    layout.elements.forEach((e, i) => {
      if (!e.visible || (fb && !overlaps.has(i))) return;
      const b = elementBox(e);   // the preview is upright, so the box is where it is drawn
      ctx.strokeRect(b.x * ZOOM + 0.5, b.y * ZOOM + 0.5, b.w * ZOOM - 1, b.h * ZOOM - 1);
    });
  }, [canvasEl, layout, rendered, overlaps, rows]);

  // ----- drag -----
  // Panel coordinates from a pointer: the canvas is drawn at 4x but CSS
  // scales it to the card's width, so go through its on-screen rectangle.
  // The preview is upright at any rotation, so these are layout coordinates.
  const toPanel = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      cx: ((clientX - r.left) * (PANEL_W * ZOOM)) / r.width,
      cy: ((clientY - r.top) * (rows * ZOOM)) / r.height,
    };
  };
  const drag = useRef<{ i: number; pointer: number; cx: number; cy: number; x: number; y: number } | null>(null);

  const hitAt = (cx: number, cy: number) => {
    return hitTest(layout.elements, cx / ZOOM, cy / ZOOM);
  };
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { cx, cy } = toPanel(ev.clientX, ev.clientY);
    const i = hitAt(cx, cy);
    if (i < 0) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const e = layout.elements[i];
    drag.current = { i, pointer: ev.pointerId, cx, cy, x: e.x, y: e.y };
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { cx, cy } = toPanel(ev.clientX, ev.clientY);
    const d = drag.current;
    if (!d || d.pointer !== ev.pointerId) {
      ev.currentTarget.style.cursor = hitAt(cx, cy) >= 0 ? 'grab' : 'default';
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
    const c = canvasEl;
    if (!c) return;
    const onTouchStart = (ev: TouchEvent) => {
      const t = ev.touches[0];
      const r = c.getBoundingClientRect();
      const rowsNow = c.height / ZOOM;
      const px = ((t.clientX - r.left) * PANEL_W) / r.width, py = ((t.clientY - r.top) * rowsNow) / r.height;
      if (hitTest(layoutRef.current.elements, px, py) >= 0) ev.preventDefault();
    };
    c.addEventListener('touchstart', onTouchStart, { passive: false });
    return () => c.removeEventListener('touchstart', onTouchStart);
  }, [canvasEl]);

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
    return send({ panel: sent.panel, rotation: sent.rotation, elements: sent.elements }, () => {
      if (layoutRef.current === sent) setDirty(false);
    });
  };
  // Reset puts the ELEMENTS back to the built-in default; a turn is how the
  // board is mounted, not part of the layout's look, so it is kept.
  const reset = () => {
    const sent = layout;
    return send({ reset: true, panel: sent.panel, rotation: sent.rotation }, () => {
      if (layoutRef.current !== sent) return;
      setLayout(turned(defaultLayout(wasm, sent.panel, device), sent.rotation));
      setDirty(false);
    });
  };

  const status = statusLine(device);
  const fieldStyle = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' };
  // max-w-full: on a phone a select sized to "180° (mounted upside down)" otherwise runs past the column.
  const field = 'h-[30px] max-w-full min-w-0 rounded-[8px] border px-2 font-mono text-[12px] disabled:cursor-not-allowed';
  const labelCls = 'text-[12px] font-medium';
  const visible = layout.elements.filter((e) => e.visible).length;
  const previewOptions = Object.entries(PREVIEWS)
    .filter(([k]) => k !== 'armed' || nfcOk)
    .map(([k, label]) => ({ value: k as PreviewKey, label, testId: `display-preview-${id}-${k}` }));

  return (
    <Shell
      device={device} onOpenChange={onOpenChange} finalFocus={finalFocus} dismissible={!busy} status={status}
      badge={dirty && (
        <span className="rounded-full px-2.5 py-1 text-[12px] font-semibold" data-testid={`display-unsaved-${id}`}
              style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}>
          Unsaved changes
        </span>
      )}
      footer={(
        <>
          <button type="button" onClick={reset} disabled={busy || refreshing} data-testid={`display-reset-${id}`}
                  title="Puts the built-in layout on the board now"
                  className="min-h-[38px] whitespace-nowrap rounded-[10px] px-2 text-[13px] font-medium hover:bg-[var(--track)] disabled:opacity-50"
                  style={{ color: 'var(--muted)' }}>
            Reset to default
          </button>
          <span className="min-w-0 flex-1" />
          {saveError && (
            <span className="text-[12px]" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
                  data-testid={`display-save-error-${id}`}>
              {saveError}
            </span>
          )}
          <button type="button" onClick={onCancel} disabled={busy} data-testid={`display-cancel-${id}`}
                  className={SECONDARY_BUTTON}
                  style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={!!problem || busy || refreshing}
                  data-testid={`display-save-${id}`}
                  className="min-h-[38px] whitespace-nowrap rounded-[10px] px-4 text-[13px] font-semibold disabled:opacity-50"
                  style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
            {busy ? 'Saving…' : 'Save to board'}
          </button>
        </>
      )}
    >
      <div className="grid min-w-0 md:grid-cols-[440px_minmax(0,1fr)]" data-testid={`display-editor-${id}`}>
        <div className="flex min-w-0 flex-col gap-[18px] border-b p-6 md:border-b-0 md:border-r"
             style={{ background: 'var(--surface-2)', borderColor: 'var(--line)' }}>
          <div className="rounded-[14px] p-5"
               style={{ background: '#1C1B18', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / .06)' }}>
            <canvas ref={setCanvas} width={PANEL_W * ZOOM} height={rows * ZOOM}
                    data-testid={`display-canvas-${id}`}
                    onPointerDown={onPointerDown} onPointerMove={onPointerMove}
                    onPointerUp={endDrag} onPointerCancel={endDrag}
                    className="mx-auto block h-auto w-full max-w-[384px]"
                    style={{
                      background: OLED_DARK,
                      aspectRatio: `${PANEL_W} / ${rows}`,
                      imageRendering: 'pixelated',
                    }} />
          </div>
          {problem && (
            <span className="text-[12px]" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
                  data-testid={`display-reason-${id}`}>
              {problem}
            </span>
          )}

          <div className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--muted-2)' }}>Preview as</span>
            <Radios label="Preview as" testId={`display-preview-${id}`} value={preview} options={previewOptions}
                    onChange={setPreview} busy={busy}
                    className="flex flex-wrap gap-1.5"
                    itemClass="h-[30px] rounded-full border px-2.5 text-[12px] font-medium" />
          </div>

          <div className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--muted-2)' }}>Panel</span>
            <Radios label="Panel size" testId={`display-panel-${id}`} value={layout.panel}
                    options={[
                      { value: '128x32' as const, label: '128×32', testId: `display-panel-${id}-128x32` },
                      { value: '128x64' as const, label: '128×64', testId: `display-panel-${id}-128x64` },
                    ]}
                    onChange={(p) => edit(turned(defaultLayout(wasm, p, device), layout.rotation))} busy={busy}
                    className="seg seg--sm self-start"
                    itemClass="seg-item font-mono !text-[12px] !font-semibold" />
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>Match the screen fitted to your board.</span>
          </div>

          <div className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--muted-2)' }}>Rotation</span>
            {rotateOk
              ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <select value={rotation} className={field} style={fieldStyle} data-testid={`display-rotation-${id}`}
                          aria-label="Rotation"
                          onChange={(ev) => edit(turned(layout, ev.target.value === '180' ? 180 : 0))}>
                    <option value={0}>0°</option>
                    <option value={180}>180° (mounted upside down)</option>
                  </select>
                  {rotation === 180 && (
                    <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid={`display-rotation-note-${id}`}>
                      Shown upright here — the board turns it 180°
                    </span>
                  )}
                </div>
              )
              : (
                // Both values of "can this board turn": a missing select would read as no such choice.
                <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid={`display-rotation-needs-fw-${id}`}>
                  Rotation needs firmware {ROTATION_FIRMWARE} or newer
                </span>
              )}
          </div>

          <button type="button" aria-pressed={snap} onClick={() => setSnap(!snap)} data-testid={`display-snap-${id}`}
                  className="flex h-8 items-center gap-2.5 self-start text-[13px] font-medium"
                  style={{ color: 'var(--ink)' }}>
            <span aria-hidden="true" className="flex h-[18px] w-8 shrink-0 rounded-full p-[2px]"
                  style={{ background: snap ? 'var(--ink)' : 'var(--line-strong)', justifyContent: snap ? 'flex-end' : 'flex-start' }}>
              <span className="size-[14px] rounded-full" style={{ background: 'var(--surface)', boxShadow: '0 1px 2px rgb(0 0 0 / .25)' }} />
            </span>
            Snap to 8 px grid
          </button>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex items-baseline justify-between gap-3 px-6 pb-2 pt-4">
            <h3 className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Elements</h3>
            <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`display-shown-count-${id}`}>
              {`${visible} of ${layout.elements.length} shown`}
            </span>
          </div>
          <ul className="flex flex-col gap-0.5 overflow-y-auto px-4 pb-4">
            {layout.elements.map((e) => {
              const look = ELEMENT_LOOK[e.id];
              const off = !e.visible;
              return (
                <li key={e.id} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] px-2 py-1.5"
                    style={{ background: off ? 'var(--modal-foot)' : undefined }}>
                  <label className="flex min-w-[200px] flex-1 items-center gap-3">
                    <input type="checkbox" checked={e.visible} data-testid={`display-visible-${e.id}`}
                           className="size-4 shrink-0" style={{ accentColor: 'var(--ink)' }}
                           onChange={(ev) => setEl(e.id, { visible: ev.target.checked })} />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[14px] font-medium" style={{ color: off ? 'var(--muted)' : 'var(--ink)' }}>{look.label}</span>
                      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>{look.hint}</span>
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]"
                       style={{ color: 'var(--muted)', opacity: off ? 0.45 : 1 }}>
                    {(e.id === 'title' || e.id === 'detail' || e.id === 'download') && (
                      <label className="flex items-center gap-1.5">
                        {e.id === 'download' ? 'Bar' : 'Width'}
                        <input type="number" min={0} max={128} value={e.w} disabled={off}
                               className={`${field} w-[58px]`} style={fieldStyle}
                               data-testid={`display-width-${e.id}`}
                               onChange={(ev) => setEl(e.id, { w: num(ev.target.value) })} />
                      </label>
                    )}
                    {e.id === 'title' && (
                      <label className="flex items-center gap-1.5">
                        Lines
                        <select value={e.opt} disabled={off} className={field} style={fieldStyle}
                                data-testid="display-lines-title"
                                onChange={(ev) => setEl(e.id, { opt: ev.target.value === '2' ? 2 : 1 })}>
                          <option value={1}>1</option>
                          <option value={2}>2</option>
                        </select>
                      </label>
                    )}
                    {e.id === 'status' && (iconOk
                      ? (
                        <label className="flex items-center gap-1.5">
                          as
                          <select value={e.opt} disabled={off} className={field} style={fieldStyle}
                                  data-testid="display-style-status"
                                  onChange={(ev) => setEl(e.id, { opt: ev.target.value === '1' ? STATUS_OPT.icon : STATUS_OPT.word })}>
                            <option value={STATUS_OPT.word}>word</option>
                            <option value={STATUS_OPT.icon}>icon</option>
                          </select>
                        </label>
                      )
                      : (
                        // Both values of "can this board show the icon": a missing select would read as no such choice.
                        <span data-testid={`display-status-icon-needs-fw-${id}`}>
                          icon needs firmware {STATUS_ICON_FIRMWARE} or newer
                        </span>
                      ))}
                    <Radios label={`${look.label} size`} testId={`display-scale-${e.id}`} value={e.scale}
                            options={([1, 2] as const).map((n) => ({
                              value: n, label: `${n}×`, testId: `display-scale-${e.id}-${n}`, disabled: off,
                            }))}
                            onChange={(n) => setEl(e.id, { scale: n })} busy={busy}
                            className="flex gap-0.5"
                            itemClass="h-[26px] w-[34px] rounded-[7px] border font-mono text-[12px] font-semibold disabled:cursor-not-allowed" />
                  </div>
                </li>
              );
            })}
            {!nfcOk && (
              // Both values of "can this board show the NFC icon": an element missing from the list would read as no
              // such feature at all.
              <li className="flex min-h-12 items-center gap-3 rounded-[10px] px-2 py-1.5 text-[13px]"
                  style={{ color: 'var(--muted)', background: 'var(--modal-foot)' }} data-testid={`display-nfc-needs-fw-${id}`}>
                <input type="checkbox" disabled aria-label="NFC (needs newer firmware)" className="size-4 shrink-0" />
                NFC — needs firmware {NFC_ELEMENT_FIRMWARE} or newer
              </li>
            )}
          </ul>
        </div>
      </div>
    </Shell>
  );
}
