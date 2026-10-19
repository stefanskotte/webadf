// Scenarios run against any listening Receive (POSIX build or FS-UAE), checked against the folder on the host.
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_KEY2, UploadStore, connect, rawConnect, type SendFile, type Outcome } from './fake-board';

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

// --- Uploads (spec 2026-10-18 §3, §10 increment 1): the board's side against a Receive that was told to send. ---

/** How a scenario asks Receive to send: the POSIX build reads stdin; FS-UAE runs a fixed startup-sequence. */
export interface UpCtl {
  send(hostPath: string): void;
  trust(): void;
  cancel(tag: string): void;
  lines(): string[];          // what Receive has printed so far (POSIX: stdout)
  dir: string;                // a host folder the scenarios may write their files into
}
export interface UpScenario { name: string; run: (port: number, host: string, ctl: UpCtl) => Promise<string | null> }

const upFile = (ctl: UpCtl, name: string, data: Buffer) => { const p = path.join(ctl.dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const waitFor = async (ctl: UpCtl, re: RegExp, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (ctl.lines().some((l) => re.test(l))) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const sameBytes = (r: { ok: boolean } & Partial<{ data: Buffer }>, want: Buffer) => (r.ok && r.data && Buffer.compare(r.data, want) === 0 ? null : `got ${JSON.stringify({ ...r, data: r.data?.length })}`);

export const UP_SCENARIOS: UpScenario[] = [
  { name: 'up-small', run: async (p, h, ctl) => {
      const data = Buffer.from('hello from the Amiga\n');
      ctl.send(upFile(ctl, 'Hello.txt', data));
      const b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload(); return sameBytes(r, data) ?? (r.path === 'Hello.txt' ? null : `path ${r.path}`); }
      finally { await b.close(); } } },
  { name: 'up-latin1', run: async (p, h, ctl) => {
      const data = Buffer.from('é');
      ctl.send(upFile(ctl, 'Café.txt', data));
      const b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload(); return sameBytes(r, data) ?? (r.path === 'Café.txt' ? null : `path ${JSON.stringify(r.path)}`); }
      finally { await b.close(); } } },
  { name: 'up-big', run: async (p, h, ctl) => {
      const data = bytes(4194304, 21); const t0 = Date.now();
      ctl.send(upFile(ctl, 'Big.bin', data));
      const b = await connect(p, h, { v: 2 });
      try { return sameBytes(await b.takeUpload({ timeoutMs: 300000 }), data); }
      finally { console.log(`  up-big: 4 MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`); await b.close(); } } },
  { name: 'up-drawer', run: async (p, h, ctl) => {
      upFile(ctl, 'Mods/a.mod', Buffer.from('a')); upFile(ctl, 'Mods/a.mod.info', Buffer.from('i')); upFile(ctl, 'Mods/sub/b.mod', Buffer.from('b'));
      ctl.send(path.join(ctl.dir, 'Mods'));
      const b = await connect(p, h, { v: 2 });
      try {
        const got = [(await b.takeUpload()).path, (await b.takeUpload()).path].sort();
        const extra = await b.maybeLine(1500);
        return JSON.stringify(got) === JSON.stringify(['Mods/a.mod', 'Mods/sub/b.mod']) && extra === null ? null : `got ${got} then ${extra}`;
      } finally { await b.close(); } } },
  { name: 'up-resume', run: async (p, h, ctl) => {
      const data = bytes(100000, 23); const store = new UploadStore();
      const f = upFile(ctl, 'Resume.bin', data);
      ctl.send(f);
      let b = await connect(p, h, { v: 2 });
      const first = await b.takeUpload({ store, dropAfterChunks: 2 });
      if (first.ok || first.code !== 'dropped') return `first try: ${JSON.stringify(first)}`;
      if (!(await waitFor(ctl, /UP_FAILED \d+ local connection lost/))) return 'Receive did not report the dropped connection';
      ctl.send(f);                                               // Retry: a new PUT, resumed from the stored chunks
      b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload({ store }); return r.offset === 32768 ? sameBytes(r, data) : `resumed at ${r.offset}`; }
      finally { await b.close(); } } },
  { name: 'up-crc', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Crc.bin', bytes(20000, 25)));
      const b = await connect(p, h, { v: 2 });
      try { const r = await b.takeUpload({ crcFault: true }); if (r.ok || r.code !== 'crc') return `got ${JSON.stringify(r)}`;
            return (await waitFor(ctl, /UP_FAILED \d+ crc /)) ? null : 'no crc failure printed'; }
      finally { await b.close(); } } },
  { name: 'up-refused', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Refused.bin', Buffer.from('x')));
      const b = await connect(p, h, { v: 2 });
      try { await b.takeUpload({ refuse: { code: 'full', text: "the web app's area is full" } });
            return (await waitFor(ctl, /UP_FAILED \d+ full the web app's area is full/)) ? null : 'no refusal printed'; }
      finally { await b.close(); } } },
  { name: 'up-v1-board', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Old.txt', Buffer.from('x')));
      const b = await connect(p, h, { v: 1 });
      try { const l = await b.maybeLine(2000); return l === null ? null : `a protocol 1 board got ${JSON.stringify(l)}`; }
      finally { await b.close(); } } },
  { name: 'up-other-key-then-trust', run: async (p, h, ctl) => {
      const b = await connect(p, h, { v: 2, key: BOARD_KEY2 });   // Old.txt still waits from up-v1-board
      try {
        const l = await b.maybeLine(2000);
        if (l !== null) return `another key got ${JSON.stringify(l)}`;
        ctl.trust();
        const r = await b.takeUpload();
        return r.ok && r.path === 'Old.txt' ? null : `after TRUST: ${JSON.stringify(r)}`;
      } finally { await b.close(); } } },
  { name: 'up-cancel-mid-file', run: async (p, h, ctl) => {
      ctl.send(upFile(ctl, 'Stop.bin', bytes(200000, 27)));
      const b = await connect(p, h, { v: 2, key: BOARD_KEY2 });   // trusted since the scenario before
      try {
        const put = await b.maybeLine(10000);
        const tag = put && /^PUT (\d+) /.exec(put)?.[1];
        if (!tag) return `no PUT: ${put}`;
        ctl.cancel(tag);                                          // before TAKE: an ABORT, answered NO busy
        const abort = await b.maybeLine(5000);
        if (abort !== `ABORT ${tag}`) return `expected ABORT ${tag}, got ${abort}`;
        // PF11: the outcome, not only the ABORT. The board answers a cancelled file NO busy (the file was never taken);
        // Receive must report that as cancelled, and the file must not go up.
        b.refuseWith(tag, 'busy', 'cancelled');
        return (await waitFor(ctl, new RegExp(`^UP_FAILED ${tag} busy cancelled$`), 5000)) && !ctl.lines().some((l) => new RegExp(`^UP_DONE ${tag} `).test(l))
          ? null : `no "UP_FAILED ${tag} busy cancelled" after the ABORT: ${JSON.stringify(ctl.lines().slice(-4))}`;
      } finally { await b.close(); } } },
];

export async function runUploadScenarios(port: number, ctl: UpCtl, opts: { host?: string; only?: string[] } = {}) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const s of UP_SCENARIOS) {
    if (opts.only && !opts.only.includes(s.name)) continue;
    try { const err = await s.run(port, opts.host ?? '127.0.0.1', ctl); out.push({ name: s.name, ok: err === null, detail: err ?? '' }); }
    catch (e) { out.push({ name: s.name, ok: false, detail: String(e) }); }
  }
  return out;
}
