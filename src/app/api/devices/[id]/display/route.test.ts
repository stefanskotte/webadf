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
const saveDisplay = vi.fn<(orgId: string, id: string, panel: string, blob: Uint8Array | null) => Promise<Saved>>();
vi.mock('@/lib/display-store', () => ({
  saveDisplay: (o: string, i: string, p: string, b: Uint8Array | null) => saveDisplay(o, i, p, b),
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

  it('refuses a malformed body with 400 invalid_body before anything is stored', async () => {
    const { PATCH } = await import('./route');
    const res = await PATCH(patch({ panel: '128x48', elements: [] }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
    expect(saveDisplay).not.toHaveBeenCalled();
  });
});
