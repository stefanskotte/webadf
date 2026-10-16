// Scenarios run against any listening Receive (POSIX build or FS-UAE), checked against the folder on the host.
import fs from 'node:fs';
import path from 'node:path';
import { connect, rawConnect, type SendFile, type Outcome } from './fake-board';

function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; }
  return b;
}
export interface Scenario { name: string; uaeOnly?: boolean; posixOnly?: boolean; explicit?: boolean /* runs only when named in --only */; run: (port: number, dir: string, host: string) => Promise<string | null> }

// Latin-1 on the wire, UTF-8 on the host (both front ends convert).
const hostName = (amigaName: string) => amigaName;
const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, hostName(rel)));
const same = (dir: string, rel: string, data: Buffer) =>
  exists(dir, rel) && Buffer.compare(fs.readFileSync(path.join(dir, hostName(rel))), data) === 0;
const noTemp = (dir: string, sub = '') => !exists(dir, path.join(sub, '.webadf-rx'));

async function one(port: number, host: string, f: SendFile): Promise<Outcome> {
  const b = await connect(port, host);
  try { b.list([f]); return await b.send(f); } finally { await b.close(); }
}
const expectOk = (o: Outcome, saved: string) => (o.ok && o.savedAs === saved ? null : `got ${JSON.stringify(o)}, want OK ${saved}`);
const expectErr = (o: Outcome, code: string) => (!o.ok && o.code === code ? null : `got ${JSON.stringify(o)}, want ERR ${code}`);

const hello = Buffer.from('hello from webadf\n');
const mod = bytes(58000, 7);

export const SCENARIOS: Scenario[] = [
  { name: 'plain', run: async (p, d, h) => expectOk(await one(p, h, { id: 's1', path: 'Hello.txt', data: hello }), 'Hello.txt')
      ?? (same(d, 'Hello.txt', hello) ? null : 'content differs') },
  { name: 'folder', run: async (p, d, h) => expectOk(await one(p, h, { id: 's2', path: 'mods/axelf.mod', data: mod }), 'mods/axelf.mod')
      ?? (same(d, 'mods/axelf.mod', mod) && noTemp(d, 'mods') ? null : 'content differs or temp left') },
  { name: 'collision', run: async (p, d, h) => expectOk(await one(p, h, { id: 's3', path: 'Hello.txt', data: Buffer.from('2') }), 'Hello_2.txt')
      ?? (same(d, 'Hello.txt', hello) ? null : 'the first Hello.txt changed') },
  { name: 'case', uaeOnly: true, run: async (p, d, h) => expectOk(await one(p, h, { id: 's4', path: 'HELLO.TXT', data: Buffer.from('3') }), 'HELLO_3.TXT')
      ?? (same(d, 'Hello.txt', hello) ? null : 'Hello.txt was overwritten') },
  { name: 'latin1', run: async (p, d, h) => expectOk(await one(p, h, { id: 's5', path: 'Café.txt', data: hello }), 'Café.txt')
      ?? (exists(d, 'Café.txt') ? null : `no Café.txt on the host: ${fs.readdirSync(d).join(', ')}`) },
  { name: 'badcrc', run: async (p, d, h) => expectErr(await one(p, h, { id: 's6', path: 'Bad.bin', data: bytes(9000, 3), badCrc: true }), 'crc')
      ?? (!exists(d, 'Bad.bin') && noTemp(d) ? null : 'Bad.bin or temp left') },
  { name: 'badname', run: async (p, d, h) => expectErr(await one(p, h, { id: 's7', path: '../Escape', data: hello }), 'name')
      ?? (!fs.existsSync(path.join(d, '..', 'Escape')) ? null : 'escaped the folder') },
  { name: 'empty', run: async (p, d, h) => expectOk(await one(p, h, { id: 's8', path: 'Empty', data: Buffer.alloc(0) }), 'Empty')
      ?? (same(d, 'Empty', Buffer.alloc(0)) ? null : 'no empty file') },
  { name: 'meta', run: async (p, _d, h) => expectOk(await one(p, h, { id: 's9', path: 'Script', data: Buffer.from('echo hi\n'), protection: 0x40, comment: 'a comment' }), 'Script') },
  { name: 'big', run: async (p, d, h) => { const big = bytes(4194304, 11); const t0 = Date.now();
      try { return expectOk(await one(p, h, { id: 's10', path: 'Big.bin', data: big }), 'Big.bin') ?? (same(d, 'Big.bin', big) ? null : 'content differs'); }
      finally { console.log(`  big: 4 MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`); } } },
  { name: 'drop', run: async (p, d, h) => {
      const o = await one(p, h, { id: 's11', path: 'Dropped.bin', data: bytes(20000, 5), dropAfter: 1000 });
      if (o.ok || o.code !== 'dropped') return `got ${JSON.stringify(o)}`;
      await new Promise((r) => setTimeout(r, 500));
      if (!noTemp(d) || exists(d, 'Dropped.bin')) return 'temp or partial file left after a drop';
      return expectOk(await one(p, h, { id: 's12', path: 'After.txt', data: hello }), 'After.txt'); } },
  { name: 'garbage', run: async (p, _d, h) => {
      const s = await rawConnect(p, h); s.write('GET / HTTP/1.0\r\n\r\n' + 'x'.repeat(2000)); await new Promise((r) => setTimeout(r, 500)); s.destroy();
      return expectOk(await one(p, h, { id: 's13', path: 'AfterJunk.txt', data: hello }), 'AfterJunk.txt'); } },
  { name: 'busy', run: async (p, _d, h) => {
      const first = await connect(p, h);
      const second = await rawConnect(p, h);
      const reply = await new Promise<string>((r) => { let b = ''; second.on('data', (d) => { b += d.toString('latin1'); if (b.includes('\n')) r(b); }); setTimeout(() => r(b), 3000); });
      second.destroy();
      const f = { id: 's14', path: 'First.txt', data: hello };
      first.list([f]); const o = await first.send(f); await first.close();
      return reply.startsWith('ERR - busy') ? expectOk(o, 'First.txt') : `second connection got ${JSON.stringify(reply)}`; } },
  // A receiver whose folder is on a nearly full volume (uae-test.sh space: an empty 880 KB floppy).
  { name: 'space', explicit: true, run: async (p, _d, h) => expectErr(await one(p, h, { id: 'sp1', path: 'TooBig.bin', data: bytes(1000000, 13) }), 'space') },
  // The folder is RAM: (the default): its handler reports the volume as full, yet files must arrive (review finding 1).
  { name: 'ramdisk', explicit: true, run: async (p, _d, h) => expectOk(await one(p, h, { id: 'rm1', path: 'InRam.txt', data: hello }), 'InRam.txt') },
  { name: 'list', run: async (p, _d, h) => {
      const b = await connect(p, h);
      b.list([{ id: 'l1', path: 'a', data: hello }, { id: 'l2', path: 'b/c', data: hello }]);
      const ok = await b.ping(); await b.close(); return ok ? null : 'no PONG after LIST'; } },
];

export async function runScenarios(port: number, dir: string, opts: { host?: string; only?: string[]; uae?: boolean } = {}) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const s of SCENARIOS) {
    if (opts.only ? !opts.only.includes(s.name) : s.explicit) continue;
    if (s.uaeOnly && !opts.uae) continue;
    if (s.posixOnly && opts.uae) continue;
    try { const err = await s.run(port, dir, opts.host ?? '127.0.0.1'); out.push({ name: s.name, ok: err === null, detail: err ?? '' }); }
    catch (e) { out.push({ name: s.name, ok: false, detail: String(e) }); }
  }
  return out;
}
