import { expect, type APIRequestContext } from '@playwright/test';
import { crc32 } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { devices } from '@/db/schema/devices';
import { hashDeviceToken } from '@/lib/device-token';
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
/** `request`: the get this file answers (NET: volumes, spec 2026-10-30 §4.5): the server places it at the copy's target. */
export async function boardOpens(request: APIRequestContext, token: string, path: string, size: number, date = '17000.600.0', rid?: string) {
  const open = await request.post('/api/device/upload', { headers: { ...authHeader(token), 'content-type': 'application/json' },
    data: amigaJson({ size, date, protection: 0, path, comment: '', ...(rid !== undefined ? { request: rid } : {}) }) });
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
/** What a 1.19.0 board does for one PUT: open, 16 KB chunks, close. `rid`: the get it answers (1.22.0). */
export async function boardUploads(request: APIRequestContext, token: string, path: string, data: Buffer, date = '17000.600.0', rid?: string) {
  const { id, offset } = await boardOpens(request, token, path, data.length, date, rid);
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

// NET: volumes (spec 2026-10-30 §2.2, §4.2): a 1.22.0 board passing Files' requests to Transfer 2.3 and its answers back.

export type BoardRequest = { id: string; kind: 'VOLS' | 'DIR' | 'GET'; path: string };
/**
 * What Transfer has: `fs['']` the volumes (each with its `device`), `fs['Work:']`, `fs['Work:Programs']` … a drawer's
 * entries by its Amiga path (looked up ignoring case, as AmigaDOS does). A file's bytes are `data`.
 */
export type FakeEntry = { name: string; device?: string; dir?: boolean; data?: Buffer; comment?: string; protection?: number };
const AMIGA_DATE = '17000.600.0';
const lp = (s: string) => `${s.length}:${s}`;

/** GET /api/device/req: the waiting requests, which the server marks sent. Latin-1 lines `VOLS <rid>` / `DIR|GET <rid> <len>:<path>`. */
export async function boardTakesRequests(request: APIRequestContext, token: string): Promise<BoardRequest[]> {
  const res = await request.get('/api/device/req', { headers: authHeader(token) });
  expect(res.status()).toBe(200);
  const text = Buffer.from(await res.body()).toString('latin1');
  return text.split('\n').filter(Boolean).map((line) => {
    const m = /^(VOLS|DIR|GET) (\S+)(?: (\d+):(.*))?$/.exec(line);
    expect(m, line).not.toBeNull();
    const [, kind, id, len, path = ''] = m!;
    if (len !== undefined) expect(path.length, line).toBe(Number(len));
    return { id, kind: kind as BoardRequest['kind'], path };
  });
}

/** POST /api/device/req/<rid>: one piece of Transfer's answer, as the firmware writes it (amigaJson). */
export async function boardAnswers(request: APIRequestContext, token: string, rid: string, lines: string[], piece = 0, last = true) {
  const res = await request.post(`/api/device/req/${rid}`, { headers: { ...authHeader(token), 'content-type': 'application/json' },
    data: amigaJson({ piece, lines, last }) });
  expect(res.status(), await res.text()).toBe(204);
}

const entriesOf = (fs: Record<string, FakeEntry[]>, path: string) =>
  Object.entries(fs).find(([k]) => k !== '' && k.toLowerCase() === path.toLowerCase())?.[1];

/** What Transfer answers to one request: the volumes, a drawer's entries, or a file's GOT and then its upload. */
export async function boardServesOne(request: APIRequestContext, token: string, fs: Record<string, FakeEntry[]>, r: BoardRequest) {
  if (r.kind === 'VOLS') {
    const vols = fs[''] ?? [];
    await boardAnswers(request, token, r.id, [
      ...vols.map((v) => `VOL ${r.id} ${lp(v.name)} ${lp(v.device ?? 'DH0:')} 104857600 43000000 ${AMIGA_DATE}`),
      `DONE ${r.id} ${vols.length}`,
    ]);
    return;
  }
  if (r.kind === 'DIR') {
    const list = entriesOf(fs, r.path);
    if (!list) { await boardAnswers(request, token, r.id, [`ERR ${r.id} notfound ${lp('Object not found')}`]); return; }
    await boardAnswers(request, token, r.id, [
      ...list.map((e) => `ENT ${r.id} ${e.dir ? 'd' : 'f'} ${e.dir ? 0 : e.data?.length ?? 0} ${(e.protection ?? 0).toString(16)} ${AMIGA_DATE} ${lp(e.name)} ${lp(e.comment ?? '')}`),
      `DONE ${r.id} ${list.length}`,
    ]);
    return;
  }
  // GET Work:Programs/a.lha: the drawer's entry by its name, then GOT and the file going up tied to the request.
  const at = r.path.lastIndexOf('/') > r.path.indexOf(':') ? r.path.lastIndexOf('/') : r.path.indexOf(':');
  const drawer = r.path.slice(0, at + (r.path[at] === ':' ? 1 : 0));
  const name = r.path.slice(at + 1);
  const file = entriesOf(fs, drawer)?.find((e) => !e.dir && e.name.toLowerCase() === name.toLowerCase());
  if (!file?.data) { await boardAnswers(request, token, r.id, [`ERR ${r.id} notfound ${lp('Object not found')}`]); return; }
  await boardAnswers(request, token, r.id, [`GOT ${r.id} 1`]);
  await boardUploads(request, token, name, file.data, AMIGA_DATE, r.id);
}

/** The board's req.v as its status poll reads it (spec 2026-10-30 §4.2): the devices row its token names. */
async function reqVersionOf(token: string): Promise<number> {
  const [d] = await getDb().select({ v: devices.reqVersion }).from(devices).where(eq(devices.tokenHash, hashDeviceToken(token)));
  expect(d, 'the board is paired').toBeDefined();
  return d.v;
}

/**
 * The board and Transfer at work: every 300 ms it reads req.v and, as firmware 1.22.0 does, takes the waiting requests
 * only when req.v has moved since it last took them (reqAck), answering each from `fs`, until `until()` or `maxMs` pass.
 * Resolves with every request it served, in order; a test awaits it so a failed answer fails the test.
 */
export async function boardServes(request: APIRequestContext, token: string, fs: Record<string, FakeEntry[]>, until: () => boolean,
  served: BoardRequest[] = [], maxMs = 30_000): Promise<BoardRequest[]> {
  const end = Date.now() + maxMs;
  let ack: number | null = null;
  while (!until() && Date.now() < end) {
    const v = await reqVersionOf(token);
    if (v !== ack) {
      ack = v;
      for (const r of await boardTakesRequests(request, token)) {
        await boardServesOne(request, token, fs, r);
        served.push(r);
      }
    }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  return served;
}
