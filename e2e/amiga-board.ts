import { expect, type APIRequestContext } from '@playwright/test';
import { crc32 } from 'node:zlib';
import { authHeader } from './device-helpers';

// A simulated board over its own routes (status, open, chunk, close), as Transfer 2.1 drives them: what
// e2e/from-amiga.spec.ts and e2e/files-stash.spec.ts send up from "the Amiga".

/** The board reports its firmware, Network mode and its key digits. */
export async function boardSays(request: APIRequestContext, token: string, firmware = '1.19.0+gabc1234', upKey = 'ab12') {
  expect((await request.post('/api/device/status', { headers: authHeader(token),
    data: { mountedSha256: null, firmwareVersion: firmware, secondDrive: 'net', driveVersion: 0, upKey } })).status()).toBe(204);
}
/**
 * The open body as the firmware writes it: a raw JSON string, application/json, with every non-ASCII character
 * (the board's Latin-1 bytes) escaped \u00XX. Playwright's `data: {...}` would send raw UTF-8 instead.
 */
export function amigaJson(o: object): string {
  return JSON.stringify(o).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export async function boardOpens(request: APIRequestContext, token: string, path: string, size: number, date = '17000.600.0') {
  const open = await request.post('/api/device/upload', { headers: { ...authHeader(token), 'content-type': 'application/json' },
    data: amigaJson({ size, date, protection: 0, path, comment: '' }) });
  expect(open.status()).toBe(200);
  return (await open.json()) as { id: string; offset: number };
}
/** Chunks of 16 KB from `from`, at most `max` of them. */
export async function boardSendsChunks(request: APIRequestContext, token: string, id: string, data: Buffer, from = 0, max = Infinity) {
  for (let at = from, n = 0; at < data.length && n < max; at += 16_384, n++) {
    const r = await request.post(`/api/device/upload/${id}?offset=${at}`, {
      headers: { ...authHeader(token), 'content-type': 'application/octet-stream' }, data: data.subarray(at, Math.min(at + 16_384, data.length)),
    });
    expect(r.status()).toBe(200);
  }
}
export const boardCloses = (request: APIRequestContext, token: string, id: string, crc: number) =>
  request.post(`/api/device/upload/${id}/close`, { headers: authHeader(token), data: { crc32: crc } });
/** What a 1.19.0 board does for one PUT: open, 16 KB chunks, close. */
export async function boardUploads(request: APIRequestContext, token: string, path: string, data: Buffer, date = '17000.600.0') {
  const { id, offset } = await boardOpens(request, token, path, data.length, date);
  await boardSendsChunks(request, token, id, data, offset);
  expect((await boardCloses(request, token, id, crc32(data) >>> 0)).status()).toBe(200);
  return id;
}

// The send side (PaulaNET Phase 4 increment 3; Files increment 3 NET:): what Transfer pulls from the board's queue.

/** The board's queue as the firmware reads it (`NEXT …` then `LIST n`), Latin-1. */
export async function boardQueue(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.get('/api/device/send/queue', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  return Buffer.from(await res.body()).toString('latin1');
}
/** The board takes its queue's NEXT file whole, in 16 KB reads, and posts the outcome; the transfer's id. */
export async function boardTakesNext(request: APIRequestContext, token: string,
  outcome: { ok: true; savedAs: string } | { ok: false; code: string; text: string }) {
  const text = await boardQueue(request, token);
  const m = /^NEXT (\S+) (\d+) /.exec(text);
  expect(m, text).not.toBeNull();
  const [, id, size] = m!;
  for (let off = 0; off < Number(size); off += 16_384) {
    expect((await request.get(`/api/device/send/${id}?offset=${off}&length=16384`, { headers: authHeader(token) })).status()).toBe(200);
  }
  expect((await request.post(`/api/device/send/${id}/done`, { headers: authHeader(token), data: outcome })).status()).toBe(204);
  return id;
}
