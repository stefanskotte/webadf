import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadDisplayWasm, STATE_SIZE } from './display-wasm';

const wasmBytes = () => readFile('public/display.wasm').then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);

describe('display wasm', () => {
  it('renders today’s 128x32 default byte-identically to the firmware golden', async () => {
    const w = await loadDisplayWasm(await wasmBytes());
    const fb = w.render({ status: 'loaded', bars: 3, title: 'Workbench 3.1 Install', detail: 'disk 1 of 6',
      showTrack: true, cyl: 0, maxCyl: 79, pct: -1, tick: 0, writable: true, sync: 'synced' }, 0, null);
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
      showTrack: false, cyl: 0, maxCyl: 79, pct: -1, tick: 0, writable: false, sync: 'offline' as const };
    const a = w.render(st, 1, null);
    const b = w.render(st, 1, w.defaultBlob(1));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = await readFile('wifi-floppy/firmware/test/fixtures/layouts/custom64.bin');
    expect(w.validate(new Uint8Array(c))).toBeNull();
    expect(w.render(st, 1, new Uint8Array(c)).length).toBe(1024);
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
