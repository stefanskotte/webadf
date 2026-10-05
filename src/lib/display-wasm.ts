// Loader for public/display.wasm: the board's own OLED renderer and layout
// validator (wifi-floppy/firmware/wasm/display_wasm.c), so the editor's preview
// is the firmware's pixels. Rebuild with `pnpm display:wasm`.

export type PanelId = 0 | 1;
export interface PreviewState {
  status: 'boot' | 'portal' | 'wifi' | 'ready' | 'download' | 'verify' | 'loaded' | 'error';
  bars: number; title: string; detail: string; showTrack: boolean; cyl: number; maxCyl: number;
  pct: number; tick: number; writable: boolean; sync: 'synced' | 'pending' | 'offline';
}
export interface DisplayWasm {
  /** null when valid, else the C validator's reason. */
  validate(blob: Uint8Array): string | null;
  /** 1024-byte framebuffer (SSD1306 page layout) for `blob` (null = the panel's default). */
  render(state: PreviewState, panel: PanelId, blob: Uint8Array | null): Uint8Array;
  defaultBlob(panel: PanelId): Uint8Array;
}

const STATUS = ['boot', 'portal', 'wifi', 'ready', 'download', 'verify', 'loaded', 'error'] as const;
const SYNC = ['synced', 'pending', 'offline'] as const;

// display_state_t on wasm32 (int/enum 4 bytes, bool 1): title[43], detail[22].
// The C side reports its own offsets (state_off); the loader refuses to run if
// they disagree with this table.
const OFF = {
  status: 0, bars: 4, title: 8, detail: 51, showTrack: 73, cyl: 76, maxCyl: 80,
  pct: 84, tick: 88, writable: 92, sync: 96,
} as const;
const FIELD_ORDER = ['status', 'bars', 'title', 'detail', 'showTrack', 'cyl', 'maxCyl', 'pct', 'tick', 'writable', 'sync'] as const;
export const STATE_SIZE = 100;
const TITLE_CAP = 43;
const DETAIL_CAP = 22;
const FB_SIZE = 1024;

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  fb_ptr(): number; blob_ptr(): number; why_ptr(): number; state_ptr(): number; out_ptr(): number;
  state_size(): number; state_off(i: number): number;
  validate(len: number): number; render(panel: number, len: number): number; default_blob(panel: number): number;
}

const WHY_CAP = 80; // g_why[80] in display_wasm.c

// The browser's one instance per page. A failed load is not kept, so a later
// caller (a remount, a retry) fetches again instead of inheriting the error.
let browserLoad: Promise<DisplayWasm> | null = null;

/**
 * Browser: fetches /display.wasm, once per page (memoised). Node/tests: pass
 * the module's bytes -- that path is deliberately NOT cached, so each test
 * gets a fresh instance.
 */
export function loadDisplayWasm(bytes?: ArrayBuffer): Promise<DisplayWasm> {
  if (bytes) return instantiate(bytes);
  browserLoad ??= fetch('/display.wasm')
    .then((res) => {
      if (!res.ok) throw new Error(`could not load /display.wasm: HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then(instantiate)
    .catch((e: unknown) => { browserLoad = null; throw e; });
  return browserLoad;
}

async function instantiate(buf: ArrayBuffer): Promise<DisplayWasm> {
  const { instance } = await WebAssembly.instantiate(buf, {
    wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
  });
  const x = instance.exports as unknown as Exports;
  x._initialize?.();

  if (x.state_size() !== STATE_SIZE) {
    throw new Error(`display.wasm state size ${x.state_size()} != ${STATE_SIZE}: rebuild or fix display-wasm.ts`);
  }
  FIELD_ORDER.forEach((f, i) => {
    if (x.state_off(i) !== OFF[f]) throw new Error(`display.wasm offset of ${f} is ${x.state_off(i)}, expected ${OFF[f]}`);
  });

  const mem = () => new Uint8Array(x.memory.buffer); // re-read: memory may grow
  const setBlob = (blob: Uint8Array | null): number => {
    if (!blob || blob.length === 0) return 0;
    mem().set(blob.subarray(0, 132), x.blob_ptr());
    return blob.length;
  };
  // The validator's NUL-terminated reason, read no further than its buffer.
  const why = (): string => {
    const m = mem(); const p = x.why_ptr();
    let e = p; while (e < p + WHY_CAP && m[e] !== 0) e++;
    return new TextDecoder().decode(m.subarray(p, e));
  };
  const putStr = (at: number, cap: number, s: string) => {
    const enc = new TextEncoder().encode(s).subarray(0, cap - 1);
    const m = mem();
    m.fill(0, at, at + cap);
    m.set(enc, at);
  };

  return {
    validate(blob) {
      if (blob.length > 132) return 'blob too long';
      const len = setBlob(blob);
      if (x.validate(len)) return null;
      return why();
    },
    render(state, panel, blob) {
      const base = x.state_ptr();
      const dv = new DataView(x.memory.buffer);
      dv.setInt32(base + OFF.status, STATUS.indexOf(state.status), true);
      dv.setInt32(base + OFF.bars, state.bars, true);
      putStr(base + OFF.title, TITLE_CAP, state.title);
      putStr(base + OFF.detail, DETAIL_CAP, state.detail);
      dv.setUint8(base + OFF.showTrack, state.showTrack ? 1 : 0);
      dv.setInt32(base + OFF.cyl, state.cyl, true);
      dv.setInt32(base + OFF.maxCyl, state.maxCyl, true);
      dv.setInt32(base + OFF.pct, state.pct, true);
      dv.setInt32(base + OFF.tick, state.tick, true);
      dv.setUint8(base + OFF.writable, state.writable ? 1 : 0);
      dv.setInt32(base + OFF.sync, SYNC.indexOf(state.sync), true);
      if (blob && blob.length > 132) throw new Error('layout blob too long');
      const len = setBlob(blob);
      if (!x.render(panel, len)) {
        throw new Error(`invalid layout: ${why()}`);
      }
      return mem().slice(x.fb_ptr(), x.fb_ptr() + FB_SIZE);
    },
    defaultBlob(panel) {
      const n = x.default_blob(panel);
      return mem().slice(x.out_ptr(), x.out_ptr() + n);
    },
  };
}
