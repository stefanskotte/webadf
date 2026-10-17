import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadDisplayWasm, STATE_SIZE, type DisplayWasm as DisplayWasmT } from './display-wasm';
import { decodeLayout, encodeLayout } from './display-layout';

const wasmBytes = () => readFile('public/display.wasm').then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);

describe('display wasm', () => {
  it('renders today’s 128x32 default byte-identically to the firmware golden', async () => {
    const w = await loadDisplayWasm(await wasmBytes());
    const fb = w.render({ status: 'loaded', bars: 3, title: 'Workbench 3.1 Install', detail: 'disk 1 of 6',
      showTrack: true, cyl: 0, maxCyl: 79, pct: -1, tick: 0, writable: true, sync: 'synced', nfc: 'armed' }, 0, null);
    const golden = await readFile('wifi-floppy/firmware/test/fixtures/display_golden/mounted_w_t0.fb');
    expect(fb.length).toBe(1024);
    expect(Buffer.from(fb.subarray(0, 512)).equals(golden)).toBe(true);
  });

  it('validates with the C rules', async () => {
    const w = await loadDisplayWasm(await wasmBytes());
    const bad = await readFile('wifi-floppy/firmware/test/fixtures/layouts/bad_bounds.bin');
    expect(w.validate(new Uint8Array(bad))).toMatch(/outside/);
    expect(w.validate(w.defaultBlob(1))).toBeNull();
  });

  it('agrees with the C struct size (loader also checks every offset)', async () => {
    const bytes = await wasmBytes();
    const { instance } = await WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }),
    });
    const ex = instance.exports as unknown as { state_size(): number };
    expect(ex.state_size()).toBe(STATE_SIZE);
  });

  it('renders a custom 128x64 fixture and a fresh blob from defaultBlob', async () => {
    const w = await loadDisplayWasm(await wasmBytes());
    const st = { status: 'ready' as const, bars: 2, title: 'x'.repeat(60), detail: 'y'.repeat(40),
      showTrack: false, cyl: 0, maxCyl: 79, pct: -1, tick: 0, writable: false, sync: 'offline' as const, nfc: 'absent' as const };
    const a = w.render(st, 1, null);
    const b = w.render(st, 1, w.defaultBlob(1));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = await readFile('wifi-floppy/firmware/test/fixtures/layouts/custom64.bin');
    expect(w.validate(new Uint8Array(c))).toBeNull();
    expect(w.render(st, 1, new Uint8Array(c)).length).toBe(1024);
  });

  // The NFC element (firmware 1.10.0): the same pixels as the firmware's own
  // nfc_* goldens (test_display_golden.c NFC_GOLDENS), drawn from a layout
  // built by the web encoder -- so encoder, struct offset and glyph all agree.
  for (const [name, panel, x, y, scale, nfc] of [
    ['nfc_present_32', 0, 100, 0, 1, 'present'],
    ['nfc_absent_32', 0, 100, 0, 1, 'absent'],
    ['nfc_armed_32', 0, 100, 0, 1, 'armed'],
    ['nfc_present_2x_64', 1, 0, 40, 2, 'present'],
    ['nfc_absent_2x_64', 1, 0, 40, 2, 'absent'],
    ['nfc_armed_2x_64', 1, 0, 40, 2, 'armed'],
  ] as const) {
    it(`renders ${name} byte-identically to the firmware golden`, async () => {
      const w = await loadDisplayWasm(await wasmBytes());
      const base = decodeLayout(w.defaultBlob(panel));
      const blob = encodeLayout({ ...base, elements: [...base.elements, { id: 'nfc', visible: true, scale, x, y, w: 0, opt: 0 }] });
      expect(w.validate(blob)).toBeNull();
      const fb = w.render({ status: 'loaded', bars: 3, title: 'Turrican', detail: 'Disk 1/2', showTrack: true,
        cyl: 12, maxCyl: 79, pct: -1, tick: 0, writable: true, sync: 'synced', nfc }, panel, blob);
      const golden = await readFile(`wifi-floppy/firmware/test/fixtures/display_golden/${name}.fb`);
      const rows = panel === 1 ? 1024 : 512;
      expect(golden.length).toBe(rows);
      expect(Buffer.from(fb.subarray(0, rows)).equals(golden)).toBe(true);
    });
  }

  // The status icon (firmware 1.15.0): the same pixels as test_display_icons.c's
  // goldens, from the panel's default with status switched to the icon by the
  // web encoder -- running states with that layout, built-in screens through
  // display_layout_for, both blink phases.
  const ICON_STATES: [string, Partial<Parameters<DisplayWasmT['render']>[0]>][] = [
    ['icon_boot', { status: 'boot', title: 'wifi-floppy', detail: 'starting' }],
    ['icon_portal', { status: 'portal', title: 'Setup needed', detail: 'wifi-floppy-6A38' }],
    ['icon_wifi', { status: 'wifi', title: 'Connecting', detail: 'HomeNet', bars: 1 }],
    ['icon_wifi_blink', { status: 'wifi', title: 'Connecting', detail: 'HomeNet', bars: 1, tick: 4 }],
    ['icon_ready', { status: 'ready', title: 'no disk' }],
    ['icon_download', { status: 'download', title: 'Workbench 3.1 Install', pct: 64 }],
    ['icon_verify', { status: 'verify', title: 'Turrican' }],
    ['icon_loaded', { status: 'loaded', title: 'Workbench 3.1 Install', detail: 'disk 1 of 6', showTrack: true, cyl: 42, writable: true }],
    ['icon_error', { status: 'error', title: 'no route', bars: -1 }],
    ['icon_error_blink', { status: 'error', title: 'no route', bars: -1, tick: 4 }],
  ];
  for (const panel of [0, 1] as const) {
    for (const [name, over] of ICON_STATES) {
      it(`renders ${name} on ${panel ? '128x64' : '128x32'} byte-identically to the firmware golden`, async () => {
        const w = await loadDisplayWasm(await wasmBytes());
        const base = decodeLayout(w.defaultBlob(panel));
        const blob = encodeLayout({ ...base, elements: base.elements.map((e) => (e.id === 'status' ? { ...e, opt: 1 } : e)) });
        expect(w.validate(blob)).toBeNull();
        const fb = w.render({ status: 'ready', bars: 3, title: '', detail: '', showTrack: false, cyl: 0, maxCyl: 79,
          pct: -1, tick: 0, writable: false, sync: 'synced', nfc: 'absent', ...over }, panel, blob);
        const golden = await readFile(`wifi-floppy/firmware/test/fixtures/display_golden/${name}_${panel ? '64' : '32'}.fb`);
        const rows = panel === 1 ? 1024 : 512;
        expect(golden.length).toBe(rows);
        expect(Buffer.from(fb.subarray(0, rows)).equals(golden)).toBe(true);
      });
    }
  }

  it('the defaults never draw the NFC icon, whatever the reader state', async () => {
    const w = await loadDisplayWasm(await wasmBytes());
    const st = { status: 'loaded' as const, bars: 3, title: 'A', detail: '', showTrack: true, cyl: 1, maxCyl: 79,
      pct: -1, tick: 0, writable: true, sync: 'synced' as const };
    for (const panel of [0, 1] as const) {
      const a = w.render({ ...st, nfc: 'absent' }, panel, null);
      const b = w.render({ ...st, nfc: 'armed' }, panel, null);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      expect(decodeLayout(w.defaultBlob(panel)).elements.some((e) => e.id === 'nfc')).toBe(false);
    }
  });
});

// The browser path (no bytes): fetches /display.wasm, once per page.
describe('display wasm in the browser', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('throws a message naming /display.wasm when the fetch is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const { loadDisplayWasm: load } = await import('./display-wasm');
    await expect(load()).rejects.toThrow(/\/display\.wasm.*404/);
  });

  it('memoises the no-argument load: one fetch for two callers', async () => {
    const bytes = await wasmBytes();
    const fetchMock = vi.fn(async () => new Response(bytes.slice(0), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadDisplayWasm: load } = await import('./display-wasm');
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(b);
    expect(await load()).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not memoise a failed load: the next call fetches again', async () => {
    const bytes = await wasmBytes();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('x', { status: 503 }))
      .mockResolvedValueOnce(new Response(bytes.slice(0), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { loadDisplayWasm: load } = await import('./display-wasm');
    await expect(load()).rejects.toThrow();
    await expect(load()).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the bytes path uncached (tests get a fresh instance each call)', async () => {
    const { loadDisplayWasm: load } = await import('./display-wasm');
    const a = await load(await wasmBytes());
    const b = await load(await wasmBytes());
    expect(a).not.toBe(b);
  });
});
