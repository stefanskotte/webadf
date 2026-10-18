// Route tests for PATCH /api/devices/[id]/display (OLED layouts spec §7). The
// session and the store are faked; the validator is NOT -- the route loads the
// real public/display.wasm, so the 400 carries the board's own C reason.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { encodeLayout, type LayoutJson } from '@/lib/display-layout';
import { loadDisplayWasm } from '@/lib/display-wasm';

vi.mock('@/lib/session', () => ({
  requireOrg: () => Promise.resolve({ orgId: 'org-1', userId: 'user-1', email: 'a@b.test' }),
}));
type Saved = { version: number } | 'not_found' | 'firmware_too_old';
const saveDisplay = vi.fn<(orgId: string, id: string, panel: string, blob: Uint8Array | null, minFirmware?: string) => Promise<Saved>>();
vi.mock('@/lib/display-store', () => ({
  saveDisplay: (...a: [string, string, string, Uint8Array | null, string?]) => saveDisplay(...a),
}));

const FIX = 'wifi-floppy/firmware/test/fixtures/layouts';
const fixture = async (name: string) => JSON.parse(await readFile(`${FIX}/${name}.json`, 'utf8')) as LayoutJson;
const patch = (body: unknown) => new Request('http://test/api/devices/dev-1/display', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ctx = (id = 'dev-1') => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  saveDisplay.mockResolvedValue({ version: 1 });
});

describe('PATCH /api/devices/[id]/display', () => {
  it('refuses an invalid layout with 400 and the WebAssembly validator\'s reason, storing nothing', async () => {
    const bad = await fixture('bad_bounds');
    const wasmBytes = await readFile('public/display.wasm');
    const wasm = await loadDisplayWasm(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));
    const expected = wasm.validate(encodeLayout(bad));
    expect(expected).toBeTruthy();

    const { PATCH } = await import('./route');
    const res = await PATCH(patch(bad), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_layout', reason: expected });
    expect(saveDisplay).not.toHaveBeenCalled();
  });

  it('answers 409 firmware_too_old when the board has not reported display layouts', async () => {
    saveDisplay.mockResolvedValue('firmware_too_old');
    const { PATCH } = await import('./route');
    const res = await PATCH(patch(await fixture('custom64')), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Needs firmware 1.7.1 or newer' });
  });

  it('answers 404 for a device that is not this org\'s, and scopes the save by the session org', async () => {
    saveDisplay.mockResolvedValue('not_found');
    const { PATCH } = await import('./route');
    const res = await PATCH(patch(await fixture('custom64')), ctx('other-org-dev'));
    expect(res.status).toBe(404);
    expect(saveDisplay).toHaveBeenCalledWith('org-1', 'other-org-dev', '128x64', expect.any(Uint8Array));
  });

  it('stores the encoded blob and answers 200 { version } with the raised version', async () => {
    saveDisplay.mockResolvedValue({ version: 7 });
    const good = await fixture('custom64');
    const { PATCH } = await import('./route');
    const res = await PATCH(patch(good), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 7 });
    const [, , panel, blob] = saveDisplay.mock.calls[0]!;
    expect(panel).toBe('128x64');
    const bin = new Uint8Array(await readFile(`${FIX}/custom64.bin`));
    expect(Buffer.from(blob!).equals(Buffer.from(bin))).toBe(true);
  });

  it('{ reset: true } clears the layout (null) for the panel and raises the version', async () => {
    saveDisplay.mockResolvedValue({ version: 8 });
    const { PATCH } = await import('./route');
    const res = await PATCH(patch({ reset: true, panel: '128x32' }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 8 });
    expect(saveDisplay).toHaveBeenCalledWith('org-1', 'dev-1', '128x32', null);
  });

  it('a layout listing the nfc element is stored only for firmware 1.10.0+ (shown or hidden)', async () => {
    const { PATCH } = await import('./route');
    for (const visible of [true, false]) {
      saveDisplay.mockClear();
      const good = await fixture('custom32_nfc');
      good.elements = good.elements.map((e) => (e.id === 'nfc' ? { ...e, visible } : e));
      const res = await PATCH(patch(good), ctx());
      expect(res.status).toBe(200);
      expect(saveDisplay).toHaveBeenCalledWith('org-1', 'dev-1', '128x32', expect.any(Uint8Array), '1.10.0');
    }
  });

  it('a layout without the nfc element carries no firmware minimum', async () => {
    const { PATCH } = await import('./route');
    await PATCH(patch(await fixture('custom64')), ctx());
    expect(saveDisplay.mock.calls[0]).toHaveLength(4);
  });

  it('an older board refused over the nfc element is told so: 409 naming 1.10.0', async () => {
    saveDisplay.mockResolvedValue('firmware_too_old');
    const { PATCH } = await import('./route');
    const res = await PATCH(patch(await fixture('custom32_nfc')), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'The NFC icon needs firmware 1.10.0 or newer' });
  });

  it('a status element drawn as the icon is stored only for firmware 1.15.0+ (shown or hidden)', async () => {
    const { PATCH } = await import('./route');
    for (const visible of [true, false]) {
      saveDisplay.mockClear();
      const good = await fixture('custom32_status_icon');
      good.elements = good.elements.map((e) => (e.id === 'status' ? { ...e, visible } : e));
      const res = await PATCH(patch(good), ctx());
      expect(res.status).toBe(200);
      expect(saveDisplay).toHaveBeenCalledWith('org-1', 'dev-1', '128x32', expect.any(Uint8Array), '1.15.0');
    }
  });

  it('the icon and the nfc element together need the newer firmware of the two', async () => {
    const { PATCH } = await import('./route');
    const l = await fixture('custom32_status_icon');
    const nfc = (await fixture('custom32_nfc')).elements.find((e) => e.id === 'nfc')!;
    await PATCH(patch({ ...l, elements: [...l.elements, nfc] }), ctx());
    expect(saveDisplay.mock.calls[0]![4]).toBe('1.15.0');
  });

  it('an older board refused over the status icon is told so: 409 naming 1.15.0', async () => {
    saveDisplay.mockResolvedValue('firmware_too_old');
    const { PATCH } = await import('./route');
    const res = await PATCH(patch(await fixture('custom32_status_icon')), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'The status icon needs firmware 1.15.0 or newer' });
  });

  // ---- firmware 1.17.0: the head element and the panel turned 180 degrees.
  it('a layout turned 180 degrees with the head element is stored, as the fixture bytes, only for 1.17.0+', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(patch(await fixture('custom32_head_rot180')), ctx());
    expect(res.status).toBe(200);
    const [, , panel, blob, min] = saveDisplay.mock.calls[0]!;
    expect(panel).toBe('128x32');
    expect(min).toBe('1.17.0');
    const bin = new Uint8Array(await readFile(`${FIX}/custom32_head_rot180.bin`));
    expect(Buffer.from(blob!).equals(Buffer.from(bin))).toBe(true);
  });

  it('the head element alone (shown or hidden), or the rotation alone, needs 1.17.0', async () => {
    const { PATCH } = await import('./route');
    const l = await fixture('custom32_head_rot180');
    for (const body of [
      { ...l, rotation: 0 },
      { ...l, rotation: 0, elements: l.elements.map((e) => ({ ...e, visible: false })) },
      { ...(await fixture('default32')), rotation: 180 },
    ]) {
      saveDisplay.mockClear();
      expect((await PATCH(patch(body), ctx())).status).toBe(200);
      expect(saveDisplay.mock.calls[0]![4]).toBe('1.17.0');
    }
  });

  it('an older board is told which 1.17.0 feature it lacks: 409', async () => {
    saveDisplay.mockResolvedValue('firmware_too_old');
    const { PATCH } = await import('./route');
    const l = await fixture('custom32_head_rot180');
    let res = await PATCH(patch(l), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'Turning the display needs firmware 1.17.0 or newer' });
    res = await PATCH(patch({ ...l, rotation: 0 }), ctx());
    expect(await res.json()).toEqual({ error: 'firmware_too_old', reason: 'The head position needs firmware 1.17.0 or newer' });
  });

  it('{ reset: true, rotation: 180 } keeps the turn: the panel\'s default elements plus the rotation record', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(patch({ reset: true, panel: '128x64', rotation: 180 }), ctx());
    expect(res.status).toBe(200);
    const [, , panel, blob, min] = saveDisplay.mock.calls[0]!;
    expect(panel).toBe('128x64');
    expect(min).toBe('1.17.0');
    const def = new Uint8Array(await readFile(`${FIX}/default64.bin`));
    const want = encodeLayout({ ...(await fixture('default64')), rotation: 180 });
    expect(Buffer.from(blob!).equals(Buffer.from(want))).toBe(true);
    expect(Buffer.from(blob!.subarray(4, def.length)).equals(Buffer.from(def.subarray(4)))).toBe(true);
  });

  it('{ reset: true, rotation: 0 } is the plain reset (null)', async () => {
    const { PATCH } = await import('./route');
    await PATCH(patch({ reset: true, panel: '128x32', rotation: 0 }), ctx());
    expect(saveDisplay).toHaveBeenCalledWith('org-1', 'dev-1', '128x32', null);
  });

  it('refuses a rotation other than 0 or 180 as invalid_body', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(patch({ ...(await fixture('default32')), rotation: 90 }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
    expect(saveDisplay).not.toHaveBeenCalled();
  });

  it('refuses a malformed body with 400 invalid_body before anything is stored', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(patch({ panel: '128x48', elements: [] }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
    expect(saveDisplay).not.toHaveBeenCalled();
  });
});
