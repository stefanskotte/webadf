// The board's side of the Receive protocol (spec 2026-10-16 §2), for tests: hello, LIST, FILE + bytes, PING.
import net from 'node:net';
import { crc32 } from 'node:zlib';

export interface SendFile {
  id: string; path: string; data: Buffer; protection?: number; comment?: string;
  badCrc?: boolean;      // send a wrong CRC
  dropAfter?: number;    // close the socket after this many data bytes
}
export type Outcome =
  | { id: string; ok: true; savedAs: string }
  | { id: string; ok: false; code: string; text: string };

const lp = (s: string) => `${Buffer.byteLength(s, 'latin1')}:${s}`;

export interface Board {
  list(files: SendFile[]): void;
  send(f: SendFile, opts?: { chunk?: number; delayMs?: number }): Promise<Outcome>;
  ping(): Promise<boolean>;
  close(): Promise<void>;   // resolves once the receiver has closed its side (or after 3 s)
}

function lineReader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  const waiting: ((l: string | null) => void)[] = [];
  const lines: string[] = [];
  let closed = false;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10)) {
      const l = buf.subarray(0, i).toString('latin1');
      buf = buf.subarray(i + 1);
      const w = waiting.shift();
      if (w) w(l); else lines.push(l);
    }
  });
  const end = () => { closed = true; while (waiting.length) waiting.shift()!(null); };
  sock.on('close', end); sock.on('error', end);
  return (timeoutMs = 15000) => new Promise<string | null>((resolve, reject) => {
    if (lines.length) return resolve(lines.shift()!);
    if (closed) return resolve(null);
    const t = setTimeout(() => reject(new Error('no reply within ' + timeoutMs + ' ms')), timeoutMs);
    waiting.push((l) => { clearTimeout(t); resolve(l); });
  });
}

export function rawConnect(port: number, host = '127.0.0.1'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(s));
    s.once('error', reject);
  });
}

export async function connect(port: number, host = '127.0.0.1'): Promise<Board> {
  const sock = await rawConnect(port, host);
  const next = lineReader(sock);
  sock.write('WEBADF 1\n');
  const hello = await next();
  if (hello !== 'READY 1') throw new Error(`expected READY 1, got ${JSON.stringify(hello)}`);
  return {
    list(files) {
      sock.write(Buffer.from(`LIST ${files.length}\n` + files.map((f) => `${f.id} ${f.data.length} ${lp(f.path)}\n`).join(''), 'latin1'));
    },
    async send(f, opts = {}) {
      const crc = (crc32(f.data) ^ (f.badCrc ? 1 : 0)) >>> 0;
      const line = `FILE ${f.id} ${f.data.length} ${crc.toString(16)} ${(f.protection ?? 0).toString(16)} ${lp(f.path)} ${lp(f.comment ?? '')}\n`;
      sock.write(Buffer.from(line, 'latin1'));
      const go = await next();
      if (go === null) throw new Error('closed before GO');
      if (go.startsWith('ERR ')) return parseErr(go);
      if (go !== `GO ${f.id}`) throw new Error(`expected GO ${f.id}, got ${go}`);
      const chunk = opts.chunk ?? 4096;
      const stop = f.dropAfter ?? f.data.length;
      for (let o = 0; o < stop; o += chunk) {
        sock.write(f.data.subarray(o, Math.min(o + chunk, stop)));
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (f.dropAfter !== undefined) {
        await new Promise((r) => setTimeout(r, 200));
        sock.destroy();
        return { id: f.id, ok: false, code: 'dropped', text: '' };
      }
      // The receiver answers after the last byte is written: allow 60 s plus 4 KB/s (an emulated or real A500
      // writes a 4 MB file in minutes, not seconds).
      const r = await next(60000 + Math.ceil(f.data.length / 4));
      if (r === null) throw new Error('closed before OK');
      if (r.startsWith('ERR ')) return parseErr(r);
      const m = /^OK (\S+) (\d+):(.*)$/.exec(r);
      if (!m || m[1] !== f.id) throw new Error(`bad reply ${r}`);
      return { id: f.id, ok: true, savedAs: m[3] };
    },
    async ping() { sock.write('PING\n'); return (await next()) === 'PONG'; },
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
