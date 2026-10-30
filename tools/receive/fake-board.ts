// The board's side of the Receive protocol, for tests: protocol 1 (spec 2026-10-16 §2: hello, LIST, FILE + bytes, PING)
// and protocol 2 (spec 2026-10-18 §3: the key in the hello, and PUT/TAKE/MORE/END/DONE/NO for files going up)
// and protocol 3 (spec 2026-10-30 §2: READY 3 <b>; VOLS, DIR and GET answered with VOL/ENT/DONE/GOT/ERR).
import net from 'node:net';
import { crc32 } from 'node:zlib';

export const BOARD_KEY = '0123456789abcdef0123456789abcdef';
export const BOARD_KEY2 = 'fedcba9876543210fedcba9876543210';
const CHUNK = 16_384;

export interface SendFile {
  id: string; path: string; data: Buffer; protection?: number; comment?: string;
  badCrc?: boolean;      // send a wrong CRC
  dropAfter?: number;    // close the socket after this many data bytes
}
export type Outcome =
  | { id: string; ok: true; savedAs: string }
  | { id: string; ok: false; code: string; text: string };

/** What the server keeps between connections: the whole chunks of each partial upload (spec U4). */
export class UploadStore {
  parts = new Map<string, Buffer>();
  key(path: string, size: number, date: string) { return `${path}|${size}|${date}`; }
}
export interface UploadOpts {
  window?: number;                          // the credit window, bytes (default 32 KB)
  refuse?: { code: string; text: string };  // answer the PUT with NO
  crcFault?: boolean;                       // answer the END with NO crc, whatever the CRC
  dropAfterChunks?: number;                 // close the socket after this many stored chunks
  store?: UploadStore;
  timeoutMs?: number;
  delayMoreMs?: number;   // wait this long before each MORE (to show progress)
}
export type UploadResult = {
  tag: string; path: string; size: number; date: string; protection: number; comment: string; offset: number;
} & ({ ok: true; data: Buffer } | { ok: false; code: string });

const lp = (s: string) => `${Buffer.byteLength(s, 'latin1')}:${s}`;

export interface Board {
  list(files: SendFile[]): void;
  send(f: SendFile, opts?: { chunk?: number; delayMs?: number }): Promise<Outcome>;
  ping(): Promise<boolean>;
  /** Waits for a PUT and plays the board for that one file (resume, credit, chunks, END, DONE or NO). */
  takeUpload(o?: UploadOpts): Promise<UploadResult>;
  /** Answers a PUT already seen with NO (what a board does with an ABORT that crossed no TAKE). */
  refuseWith(tag: string, code: string, text: string): void;
  /** Waits up to ms for a line; null if none came. */
  maybeLine(ms: number): Promise<string | null>;
  /** READY 3's flag: the Amiga's owner lets the web app browse (protocol 3; false on 1 and 2). */
  browse: boolean;
  /** Protocol 3: sends a VOLS, DIR or GET line and returns its answer, up to DONE, ERR or GOT for its id. */
  request(line: string, ms?: number): Promise<string[]>;
  /** The answer lines of request id, up to DONE, ERR or GOT (lines for other ids, and PONG, are skipped). */
  answer(id: string, ms?: number): Promise<string[]>;
  /** Writes one line and does not wait. */
  write(line: string): void;
  /** True once the receiver closes the connection within ms. */
  closed(ms: number): Promise<boolean>;
  close(): Promise<void>;   // resolves once the receiver has closed its side (or after 3 s)
}

/** Lines and raw bytes off one socket, in order. */
function byteReader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  let closed = false;
  let wake: (() => void) | null = null;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); wake?.(); });
  const end = () => { closed = true; wake?.(); };
  sock.on('close', end); sock.on('error', end);
  const until = async (ready: () => boolean, ms: number) => {
    const t0 = Date.now();
    while (!ready()) {
      if (closed) return false;
      const left = ms - (Date.now() - t0);
      if (left <= 0) throw new Error('no reply within ' + ms + ' ms');
      await new Promise<void>((r) => { const t = setTimeout(r, left); wake = () => { clearTimeout(t); r(); }; });
      wake = null;
    }
    return true;
  };
  return {
    buffered: () => buf.length,
    async line(ms = 15000): Promise<string | null> {
      if (!(await until(() => buf.indexOf(10) >= 0, ms))) return null;
      const i = buf.indexOf(10);
      const l = buf.subarray(0, i).toString('latin1');
      buf = buf.subarray(i + 1);
      return l;
    },
    /** Waits up to ms for the receiver to close the connection; false if it stayed open. */
    async closed(ms: number): Promise<boolean> {
      try { await until(() => false, ms); } catch { return false; }
      return true;
    },
    async bytes(n: number, ms = 15000): Promise<Buffer | null> {
      if (!(await until(() => buf.length >= n, ms))) return null;
      const b = buf.subarray(0, n);
      buf = buf.subarray(n);
      return Buffer.from(b);
    },
  };
}

/** "<len>:<bytes>" fields of a Latin-1 line, from position at. */
function lenField(l: string, at: number): { v: string; next: number } | null {
  const m = /^(\d+):/.exec(l.slice(at));
  if (!m) return null;
  const start = at + m[0].length;
  const v = l.slice(start, start + Number(m[1]));
  if (v.length !== Number(m[1])) return null;
  return { v, next: start + v.length + 1 };
}

export function rawConnect(port: number, host = '127.0.0.1'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(s));
    s.once('error', reject);
  });
}

export async function connect(port: number, host = '127.0.0.1', opts: { v?: 1 | 2 | 3; key?: string } = {}): Promise<Board> {
  const v = opts.v ?? 1;
  const sock = await rawConnect(port, host);
  const rd = byteReader(sock);
  sock.write(v >= 2 ? `WEBADF ${v} ${opts.key ?? BOARD_KEY}\n` : 'WEBADF 1\n');
  const hello = await rd.line();
  const m3 = v === 3 ? /^READY 3 ([01])$/.exec(hello ?? '') : null;
  if (v === 3 ? !m3 : hello !== `READY ${v}`) throw new Error(`expected READY ${v}, got ${JSON.stringify(hello)}`);
  const answer = async (id: string, ms = 60000) => {
    const out: string[] = [];
    for (;;) {
      const l = await rd.line(ms);
      if (l === null) throw new Error(`closed during the answer to ${id}: ${JSON.stringify(out.slice(-3))}`);
      const [verb, rid] = l.split(' ');
      if (rid !== id) continue;
      out.push(l);
      if (verb === 'DONE' || verb === 'ERR' || verb === 'GOT') return out;
    }
  };
  return {
    browse: m3 ? m3[1] === '1' : false,
    request(line, ms) { sock.write(Buffer.from(`${line}\n`, 'latin1')); return answer(line.split(' ')[1], ms); },
    answer,
    write(line) { sock.write(Buffer.from(`${line}\n`, 'latin1')); },
    closed: (ms) => rd.closed(ms),
    list(files) {
      sock.write(Buffer.from(`LIST ${files.length}\n` + files.map((f) => `${f.id} ${f.data.length} ${lp(f.path)}\n`).join(''), 'latin1'));
    },
    async send(f, o = {}) {
      const crc = (crc32(f.data) ^ (f.badCrc ? 1 : 0)) >>> 0;
      const line = `FILE ${f.id} ${f.data.length} ${crc.toString(16)} ${(f.protection ?? 0).toString(16)} ${lp(f.path)} ${lp(f.comment ?? '')}\n`;
      sock.write(Buffer.from(line, 'latin1'));
      const go = await rd.line();
      if (go === null) throw new Error('closed before GO');
      if (go.startsWith('ERR ')) return parseErr(go);
      if (go !== `GO ${f.id}`) throw new Error(`expected GO ${f.id}, got ${go}`);
      const chunk = o.chunk ?? 4096;
      const stop = f.dropAfter ?? f.data.length;
      for (let at = 0; at < stop; at += chunk) {
        sock.write(f.data.subarray(at, Math.min(at + chunk, stop)));
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      }
      if (f.dropAfter !== undefined) {
        await new Promise((r) => setTimeout(r, 200));
        sock.destroy();
        return { id: f.id, ok: false, code: 'dropped', text: '' };
      }
      // The receiver answers after the last byte is written: allow 60 s plus 4 KB/s (an emulated or real A500
      // writes a 4 MB file in minutes, not seconds).
      const r = await rd.line(60000 + Math.ceil(f.data.length / 4));
      if (r === null) throw new Error('closed before OK');
      if (r.startsWith('ERR ')) return parseErr(r);
      const m = /^OK (\S+) (\d+):(.*)$/.exec(r);
      if (!m || m[1] !== f.id) throw new Error(`bad reply ${r}`);
      return { id: f.id, ok: true, savedAs: m[3] };
    },
    async ping() { sock.write('PING\n'); return (await rd.line()) === 'PONG'; },
    refuseWith(tag, code, text) { sock.write(Buffer.from(`NO ${tag} ${code} ${lp(text)}\n`, 'latin1')); },
    async maybeLine(ms) { try { return await rd.line(ms); } catch { return null; } },
    async takeUpload(o = {}) {
      const ms = o.timeoutMs ?? 15000;
      const put = await rd.line(ms);
      if (put === null) throw new Error('closed before PUT');
      const m = /^PUT (\d{1,9}) (\d+) (\d+\.\d+\.\d+) ([0-9a-f]{1,8}) /.exec(put);
      if (!m) throw new Error(`bad PUT ${JSON.stringify(put)}`);
      const pathF = lenField(put, m[0].length);
      const comF = pathF && lenField(put, pathF.next);
      if (!pathF || !comF) throw new Error(`bad PUT fields ${JSON.stringify(put)}`);
      const head = { tag: m[1], size: Number(m[2]), date: m[3], protection: parseInt(m[4], 16), path: pathF.v, comment: comF.v };
      if (o.refuse) {
        sock.write(Buffer.from(`NO ${head.tag} ${o.refuse.code} ${lp(o.refuse.text)}\n`, 'latin1'));
        return { ...head, offset: 0, ok: false, code: o.refuse.code };
      }
      const store = o.store ?? new UploadStore();
      const key = store.key(head.path, head.size, head.date);
      const have = store.parts.get(key) ?? Buffer.alloc(0);
      const offset = have.length;   // whole chunks only (below), so a chunk boundary or the size
      const W = o.window ?? 32_768;
      let credit = Math.min(head.size, offset + W);
      sock.write(`TAKE ${head.tag} ${offset} ${credit}\n`);
      let got = have;
      let chunks = 0;
      while (got.length < head.size) {
        // The credit is never exceeded: what has arrived beyond the stored bytes is at most credit - stored.
        // (Once the credit reaches the size, END may already be buffered behind the last bytes, so only before that.)
        if (credit < head.size && got.length + rd.buffered() > credit) throw new Error(`past the credit: ${got.length + rd.buffered()} > ${credit}`);
        const n = Math.min(CHUNK, head.size - got.length);
        const piece = await rd.bytes(n, Math.max(ms, 60000 + n));
        if (piece === null) return { ...head, offset, ok: false, code: 'closed' };
        got = Buffer.concat([got, piece]);
        store.parts.set(key, got);
        chunks++;
        if (o.dropAfterChunks !== undefined && chunks >= o.dropAfterChunks) {
          sock.destroy();
          return { ...head, offset, ok: false, code: 'dropped' };
        }
        credit = Math.min(head.size, got.length + W);
        if (o.delayMoreMs) await new Promise((r) => setTimeout(r, o.delayMoreMs));
        sock.write(`MORE ${head.tag} ${credit} ${got.length}\n`);
      }
      const end = await rd.line(Math.max(ms, 60000));
      const e = end && /^END (\d+) ([0-9a-f]{1,8})$/.exec(end);
      if (!e || e[1] !== head.tag) throw new Error(`expected END ${head.tag}, got ${JSON.stringify(end)}`);
      store.parts.delete(key);
      if (o.crcFault || parseInt(e[2], 16) !== crc32(got) >>> 0) {
        sock.write(`NO ${head.tag} crc 18:damaged on the way\n`);
        return { ...head, offset, ok: false, code: 'crc' };
      }
      sock.write(Buffer.from(`DONE ${head.tag} ${lp(head.path)}\n`, 'latin1'));
      return { ...head, offset, ok: true, data: got };
    },
    close() {
      // A board waits for the receiver to close before reconnecting; a new connection sent while the old one is
      // still open is answered "busy".
      return new Promise<void>((r) => { if (sock.destroyed) return r(); const t = setTimeout(() => { sock.destroy(); r(); }, 3000);
        sock.once('close', () => { clearTimeout(t); r(); }); sock.end(); });
    },
  };
}

function parseErr(l: string): Outcome {
  const m = /^ERR (\S+) (\S+) (.*)$/.exec(l);
  if (!m) throw new Error(`bad ERR ${l}`);
  return { id: m[1], ok: false, code: m[2], text: m[3] };
}
