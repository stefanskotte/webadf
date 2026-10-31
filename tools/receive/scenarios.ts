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
  // Protocol 3, browsing off (the default; spec 2026-10-30 §2.3): the hello says so and every request is refused.
  { name: 'browse-off', run: async (p, _d, h) => {
      const b = await connect(p, h, { v: 3 });
      try {
        if (b.browse) return 'READY 3 1 with browsing off';
        const a = await b.request('VOLS o1');
        return a.join('|') === 'ERR o1 off 27:browsing is off in Transfer' ? null : `got ${JSON.stringify(a)}`;
      } finally { await b.close(); } } },
  // Protocol 4, both switches off (the default; spec 2026-10-31 §2.4): READY 4 0 0, and a write is refused readonly.
  { name: 'write-off', run: async (p, _d, h) => {
      const b = await connect(p, h, { v: 4 });
      try {
        if (b.browse || b.writable) return `READY 4 ${b.browse ? 1 : 0} ${b.writable ? 1 : 0} with both switches off`;
        const a = await b.request('MKDIR w1 9:Work:Nope');
        if (a.join('|') !== 'ERR w1 readonly 26:writing is off in Transfer') return `got ${JSON.stringify(a)}`;
        const o = await b.send({ id: 'w2', path: 'Work:x', data: hello, mode: 'keep' });
        return !o.ok && o.code === 'readonly' ? null : `FILE: ${JSON.stringify(o)}`;
      } finally { await b.close(); } } },
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

// --- Browsing (spec 2026-10-30 §2): the board's side of VOLS, DIR and GET against Transfer with browsing on. ---

/** Work:Programs/a.txt holds this; the fixture is the same on the POSIX build and in FS-UAE (uae-test.sh browse). */
export const A_TXT = Buffer.from('hello from the Amiga\n');
/**
 * The POSIX build's volumes, under root:
 * - Work (DH0:) holds Programs/a.txt, and Big/ with 1005 empty files f0000..f1004;
 * - two volumes are named Empty, in DF0: and DF2:, each with a Which.txt saying "df0\n" or "df2\n".
 *
 * Returns the RX_VOLS value for rx_posix.
 */
export function makeBrowseFixture(root: string): string {
  const w = path.join(root, 'Work');
  fs.mkdirSync(path.join(w, 'Programs'), { recursive: true }); fs.mkdirSync(path.join(w, 'Big'));
  fs.writeFileSync(path.join(w, 'Programs', 'a.txt'), A_TXT);
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(w, 'Big', `f${String(i).padStart(4, '0')}`), '');
  for (const d of ['0', '2']) { fs.mkdirSync(path.join(root, `Empty${d}`)); fs.writeFileSync(path.join(root, `Empty${d}`, 'Which.txt'), `df${d}\n`); }
  return `Work|DH0:|${w};Empty|DF0:|${path.join(root, 'Empty0')};Empty|DF2:|${path.join(root, 'Empty2')}`;
}
/** How a browse scenario changes Transfer: the POSIX build reads stdin; FS-UAE cannot, so those scenarios are POSIX-only. */
export interface BrowseCtl { browse?(on: boolean): void; send?(hostPath: string): void; dir?: string }
export interface BrowseScenario { name: string; posixOnly?: boolean; run: (port: number, host: string, ctl: BrowseCtl) => Promise<string | null> }
const lenp = (s: string) => `${Buffer.byteLength(s, 'latin1')}:${s}`;
async function b3(p: number, h: string) {
  const b = await connect(p, h, { v: 3 });
  if (!b.browse) { await b.close(); throw new Error('READY 3 0: browsing is off'); }
  return b;
}
const oneLine = (a: string[], want: RegExp) => (a.length === 1 && want.test(a[0]) ? null : `got ${JSON.stringify(a)}`);

export const BROWSE_SCENARIOS: BrowseScenario[] = [
  { name: 'b-vols', run: async (p, h) => { const b = await b3(p, h); try {
      const a = await b.request('VOLS v1');
      const vols = a.filter((l) => l.startsWith('VOL v1 '));
      if (a[a.length - 1] !== `DONE v1 ${vols.length}`) return `ended ${a[a.length - 1]} after ${vols.length} VOL lines`;
      if (!vols.some((l) => /^VOL v1 4:Work 4:DH0: \d+ \d+ \d+\.\d+\.\d+$/.test(l))) return `no Work in DH0: ${JSON.stringify(vols)}`;
      const empties = vols.filter((l) => l.startsWith('VOL v1 5:Empty ')).map((l) => l.split(' ')[3]).sort();
      return JSON.stringify(empties) === '["4:DF0:","4:DF2:"]' ? null : `the two Empty volumes, both plain: ${JSON.stringify(vols)}`;
    } finally { await b.close(); } } },
  { name: 'b-dir', run: async (p, h) => { const b = await b3(p, h); try {
      const a = await b.request(`DIR d1 ${lenp('Work:Programs')}`);
      return a.length === 2 && /^ENT d1 f 21 [0-9a-f]+ \d+\.\d+\.\d+ 5:a\.txt 0:$/.test(a[0]) && a[1] === 'DONE d1 1' ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  { name: 'b-device-path', run: async (p, h) => { const b = await b3(p, h); try {
      // The server sends a path through the second "Empty" as its device's path (spec §2.2): DF2: must be DF2's disk.
      const a = await b.request(`DIR d2 ${lenp('DF2:')}`);
      if (!a.some((l) => / 9:Which\.txt 0:$/.test(l)) || a[a.length - 1] !== 'DONE d2 1') return `DIR DF2: ${JSON.stringify(a)}`;
      const g = await b.request(`GET g0 ${lenp('DF2:Which.txt')}`);
      const tag = /^GOT g0 (\d+)$/.exec(g[0] ?? '')?.[1];
      if (!tag) return `GET: ${JSON.stringify(g)}`;
      const r = await b.takeUpload();
      return r.ok && r.tag === tag && r.data.toString('latin1') === 'df2\n' ? null : `got ${JSON.stringify({ ...r, data: r.ok ? r.data.toString('latin1') : undefined })}`;
    } finally { await b.close(); } } },
  { name: 'b-cut', run: async (p, h) => { const b = await b3(p, h); try {
      const a = await b.request(`DIR d3 ${lenp('Work:Big')}`, 300000);
      const ents = a.filter((l) => l.startsWith('ENT d3 f 0 ')).length;
      return ents === 1000 && a.length === 1001 && a[1000] === 'DONE d3 1000 cut' ? null : `${ents} entries, then ${a[a.length - 1]}`;
    } finally { await b.close(); } } },
  { name: 'b-notfound', run: async (p, h) => { const b = await b3(p, h); try {
      return oneLine(await b.request(`DIR d4 ${lenp('Work:Nope')}`), /^ERR d4 notfound \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'b-notdir', run: async (p, h) => { const b = await b3(p, h); try {
      return oneLine(await b.request(`DIR d5 ${lenp('Work:Programs/a.txt')}`), /^ERR d5 notdir \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'b-get', run: async (p, h) => { const b = await b3(p, h); try {
      const g = await b.request(`GET g1 ${lenp('Work:Programs/a.txt')}`);
      const tag = /^GOT g1 (\d+)$/.exec(g[0] ?? '')?.[1];
      if (!tag || g.length !== 1) return `got ${JSON.stringify(g)}`;
      const r = await b.takeUpload();
      return r.ok && r.tag === tag && r.path === 'a.txt' && Buffer.compare(r.data, A_TXT) === 0 ? null : `got ${JSON.stringify({ ...r, data: undefined })}`;
    } finally { await b.close(); } } },
  { name: 'b-isdir', run: async (p, h) => { const b = await b3(p, h); try {
      return oneLine(await b.request(`GET g2 ${lenp('Work:Programs')}`), /^ERR g2 isdir \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'b-bad', run: async (p, h) => { const b = await b3(p, h); try {
      return oneLine(await b.request('DIR x1 nope'), /^ERR x1 bad 11:bad request$/);
    } finally { await b.close(); } } },
  // Spec §2.2 Order: a request arriving while a file goes up waits, and is answered once the file is done.
  { name: 'b-waits-behind-a-file', posixOnly: true, run: async (p, h, ctl) => {
      const f = path.join(ctl.dir!, 'Wait.bin'); fs.writeFileSync(f, bytes(100000, 31));
      ctl.send!(f);
      const b = await b3(p, h);
      try {
        b.write('VOLS w1');   // Transfer has sent the PUT already: this request waits behind the file
        const r = await b.takeUpload();
        if (!r.ok) return `upload: ${JSON.stringify({ ...r, data: undefined })}`;
        const a = await b.answer('w1');
        return a[a.length - 1].startsWith('DONE w1 ') ? null : `got ${JSON.stringify(a)}`;
      } finally { await b.close(); } } },
  // Plan ruling T1: switching browsing off closes an idle connection, so the board hears READY 3 0 when it reconnects.
  { name: 'b-switch-reconnects', posixOnly: true, run: async (p, h, ctl) => {
      let b = await b3(p, h);
      ctl.browse!(false);
      if (!(await b.closed(5000))) { await b.close(); return 'still open after switching off'; }
      b = await connect(p, h, { v: 3 });
      try {
        if (b.browse) return 'READY 3 1 after switching off';
        const a = await b.request('VOLS s1');
        if (a.join('|') !== 'ERR s1 off 27:browsing is off in Transfer') return `got ${JSON.stringify(a)}`;
        ctl.browse!(true);
        if (!(await b.closed(5000))) return 'still open after switching on';
      } finally { await b.close(); }
      b = await connect(p, h, { v: 3 });
      try { return b.browse ? null : 'READY 3 0 after switching on'; } finally { await b.close(); } } },
];

// --- Writing (spec 2026-10-31 §2): the board's side of protocol 4 against Transfer with browsing and writing on. ---

/**
 * The volumes the write scenarios expect, the same on the POSIX build and in FS-UAE (uae-test.sh write):
 * - Work (DH0:) holds Tools/ (empty), a.txt ("a\n"), Keep.txt ("old\n"), Old/ with 300 empty files f000..f299;
 *   for protocol 5, One5.txt ("1"), Empty5/, Full5/ holding f ("f"), Old5/ with 60 empty files f00..f59;
 * - Prot (DF0:), a write-protected disk;
 * - Full (DF2:), a disk with less than 300 KB free; in FS-UAE it also holds Locked (its d-bit off), Stuck/ with two
 *   files and Stuck/locked (its d-bit off), and Hold.txt (empty), held open by a running command.
 *
 * Writes the POSIX build's folders under root and returns the RX_VOLS value (RX_WPROT=Prot, RX_FULL=Full make the
 * other two).
 */
export function makeWriteFixture(root: string): string {
  const w = path.join(root, 'Work');
  fs.mkdirSync(path.join(w, 'Tools'), { recursive: true }); fs.mkdirSync(path.join(w, 'Old'));
  fs.writeFileSync(path.join(w, 'a.txt'), 'a\n'); fs.writeFileSync(path.join(w, 'Keep.txt'), 'old\n');
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(w, 'Old', `f${String(i).padStart(3, '0')}`), '');
  // Linked/ holds a file and Libs, a link to Tools (the POSIX build only: w-delete-link)
  fs.mkdirSync(path.join(w, 'Linked')); fs.writeFileSync(path.join(w, 'Linked', 'f'), 'f');
  fs.symlinkSync(path.join(w, 'Tools'), path.join(w, 'Linked', 'Libs'));
  // protocol 5 (spec §9): One5.txt, Empty5/, Full5/f, Old5/ with 60 files
  fs.writeFileSync(path.join(w, 'One5.txt'), '1'); fs.mkdirSync(path.join(w, 'Empty5'));
  fs.mkdirSync(path.join(w, 'Full5')); fs.writeFileSync(path.join(w, 'Full5', 'f'), 'f'); fs.mkdirSync(path.join(w, 'Old5'));
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(w, 'Old5', `f${String(i).padStart(2, '0')}`), '');
  fs.mkdirSync(path.join(root, 'Prot')); fs.mkdirSync(path.join(root, 'Full'));
  return `Work|DH0:|${w};Prot|DF0:|${path.join(root, 'Prot')};Full|DF2:|${path.join(root, 'Full')}`;
}
/** work: the host folder that is Work:; write: switch writing (POSIX build only). */
export interface WriteCtl { work: string; write?(on: boolean): void }
export interface WriteScenario { name: string; uaeOnly?: boolean; posixOnly?: boolean; run: (port: number, host: string, ctl: WriteCtl) => Promise<string | null> }
async function b4(p: number, h: string) {
  const b = await connect(p, h, { v: 4 });
  if (!b.writable) { await b.close(); throw new Error(`READY 4 ${b.browse ? 1 : 0} 0: writing is off`); }
  return b;
}
async function b5(p: number, h: string) {
  const b = await connect(p, h, { v: 5 });
  if (!b.writable) { await b.close(); throw new Error(`READY 5 ${b.browse ? 1 : 0} 0: writing is off`); }
  return b;
}
const onWork = (ctl: WriteCtl, rel: string) => path.join(ctl.work, rel);
const hostHolds = (ctl: WriteCtl, rel: string, want: string | Buffer) =>
  fs.existsSync(onWork(ctl, rel)) && Buffer.compare(fs.readFileSync(onWork(ctl, rel)), Buffer.from(want)) === 0;
/** The ENT line of name in drawer, or null. */
async function ent(b: Awaited<ReturnType<typeof connect>>, drawer: string, name: string) {
  const a = await b.request(`DIR e${Date.now() % 100000} ${lenp(drawer)}`);
  return a.find((l) => l.includes(` ${lenp(name)} `)) ?? null;
}
const X_TXT = Buffer.from('copied onto the Amiga\n');

export const WRITE_SCENARIOS: WriteScenario[] = [
  { name: 'w-hello', run: async (p, h) => { const b = await connect(p, h, { v: 4 }); try {
      return b.browse && b.writable ? null : `READY 4 ${b.browse ? 1 : 0} ${b.writable ? 1 : 0}`;
    } finally { await b.close(); } } },
  { name: 'w-file-new', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      return expectOk(await b.send({ id: 'n1', path: 'Work:Tools/x.txt', data: X_TXT, mode: 'keep' }), 'Work:Tools/x.txt')
        ?? (hostHolds(ctl, 'Tools/x.txt', X_TXT) && !fs.existsSync(onWork(ctl, 'Tools/.webadf-rx')) ? null : 'not on the host, or the temp left');
    } finally { await b.close(); } } },
  { name: 'w-file-parents', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      return expectOk(await b.send({ id: 'n2', path: 'Work:New/Deep/y.txt', data: hello, mode: 'keep' }), 'Work:New/Deep/y.txt')
        ?? (hostHolds(ctl, 'New/Deep/y.txt', hello) ? null : 'not on the host');
    } finally { await b.close(); } } },
  { name: 'w-file-keep', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      return expectOk(await b.send({ id: 'k1', path: 'Work:Keep.txt', data: Buffer.from('new\n'), mode: 'keep' }), 'Work:Keep_2.txt')
        ?? (hostHolds(ctl, 'Keep.txt', 'old\n') && hostHolds(ctl, 'Keep_2.txt', 'new\n') ? null : 'the old file changed');
    } finally { await b.close(); } } },
  { name: 'w-file-replace', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      return expectOk(await b.send({ id: 'r1', path: 'Work:Keep.txt', data: Buffer.from('newer\n'), mode: 'replace' }), 'Work:Keep.txt')
        ?? (hostHolds(ctl, 'Keep.txt', 'newer\n') && !fs.existsSync(onWork(ctl, 'Keep_3.txt')) ? null : 'not replaced in place');
    } finally { await b.close(); } } },
  { name: 'w-file-skip', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      const o = await b.send({ id: 's1', path: 'Work:Keep.txt', data: Buffer.from('skipped\n'), mode: 'skip' });
      if (o.ok || o.code !== 'skip') return `got ${JSON.stringify(o)}`;
      if (!(await b.ping())) return 'no PONG after SKIP: bytes were awaited';
      return hostHolds(ctl, 'Keep.txt', 'newer\n') ? null : 'Keep.txt changed';
    } finally { await b.close(); } } },
  { name: 'w-file-wprot', run: async (p, h) => { const b = await b4(p, h); try {
      return expectErr(await b.send({ id: 'p1', path: 'Prot:x.txt', data: hello, mode: 'keep' }), 'wprot');
    } finally { await b.close(); } } },
  { name: 'w-file-full', run: async (p, h) => { const b = await b4(p, h); try {
      return expectErr(await b.send({ id: 'f1', path: 'Full:big.bin', data: bytes(300000, 41), mode: 'keep' }), 'full');
    } finally { await b.close(); } } },
  { name: 'w-mkdir', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      const a = await b.request(`MKDIR m1 ${lenp('Work:Made')}`);
      if (a.join('|') !== 'DONE m1 1' || !fs.statSync(onWork(ctl, 'Made')).isDirectory()) return `MKDIR: ${JSON.stringify(a)}`;
      return oneLine(await b.request(`MKDIR m2 ${lenp('Work:Made')}`), /^ERR m2 exists \d+:.+$/)
        ?? oneLine(await b.request(`MKDIR m3 ${lenp('Work:No/Sub')}`), /^ERR m3 notfound \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'w-mkdir-wprot', run: async (p, h) => { const b = await b4(p, h); try {
      return oneLine(await b.request(`MKDIR m4 ${lenp('Prot:New')}`), /^ERR m4 wprot \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'w-rename', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      const a = await b.request(`RENAME r1 ${lenp('Work:a.txt')} ${lenp('Work:Tools/a.txt')}`);
      return a.join('|') === 'DONE r1 1' && hostHolds(ctl, 'Tools/a.txt', 'a\n') && !fs.existsSync(onWork(ctl, 'a.txt')) ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  { name: 'w-rename-xvol', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      return oneLine(await b.request(`RENAME r2 ${lenp('Work:Tools/a.txt')} ${lenp('Full:a.txt')}`), /^ERR r2 xvol 30:rename works within one volume$/)
        ?? (hostHolds(ctl, 'Tools/a.txt', 'a\n') ? null : 'the file moved');
    } finally { await b.close(); } } },
  { name: 'w-protect', run: async (p, h) => { const b = await b4(p, h); try {
      const a = await b.request(`PROTECT p2 ${lenp('Work:Tools/x.txt')} 50`);
      if (a.join('|') !== 'DONE p2 1') return `got ${JSON.stringify(a)}`;
      const e = await ent(b, 'Work:Tools', 'x.txt');
      return e && / f \d+ 50 /.test(e) ? null : `the listing says ${e}`;
    } finally { await b.close(); } } },
  { name: 'w-note', run: async (p, h) => { const b = await b4(p, h); try {
      const a = await b.request(`NOTE c1 ${lenp('Work:Tools/x.txt')} ${lenp('from the web')}`);
      if (a.join('|') !== 'DONE c1 1') return `got ${JSON.stringify(a)}`;
      const e = await ent(b, 'Work:Tools', 'x.txt');
      return e && e.endsWith(' 12:from the web') ? null : `the listing says ${e}`;
    } finally { await b.close(); } } },
  { name: 'w-delete-file', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      const a = await b.request(`DELETE d1 ${lenp('Work:Tools/x.txt')}`);
      return a.join('|') === 'DONE d1 1' && !fs.existsSync(onWork(ctl, 'Tools/x.txt')) ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  { name: 'w-delete-300', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      const a = await b.request(`DELETE d2 ${lenp('Work:Old')}`, 300000);
      const want = [50, 100, 150, 200, 250, 300].map((n) => `DEL d2 ${n}`).concat('DONE d2 301');
      return JSON.stringify(a) === JSON.stringify(want) && !fs.existsSync(onWork(ctl, 'Old')) ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  // Final review C1: a link inside a drawer is removed as a link; its target is never entered.
  { name: 'w-delete-link', posixOnly: true, run: async (p, h, ctl) => { const b = await b4(p, h); try {
      const a = await b.request(`DELETE d5 ${lenp('Work:Linked')}`);
      return a.join('|') === 'DONE d5 3' && !fs.existsSync(onWork(ctl, 'Linked')) && hostHolds(ctl, 'Tools/a.txt', 'a\n')
        ? null : `got ${JSON.stringify(a)}; Tools holds ${fs.readdirSync(onWork(ctl, 'Tools')).join(',')}`;
    } finally { await b.close(); } } },
  { name: 'w-delete-denied', uaeOnly: true, run: async (p, h) => { const b = await b4(p, h); try {
      return oneLine(await b.request(`DELETE d3 ${lenp('Full:Locked')}`), /^ERR d3 denied \d+:.+$/);
    } finally { await b.close(); } } },
  { name: 'w-delete-stops', uaeOnly: true, run: async (p, h) => { const b = await b4(p, h); try {
      const a = await b.request(`DELETE d4 ${lenp('Full:Stuck')}`);
      return a.length === 2 && /^DEL d4 [0-2]$/.test(a[0]) && /^ERR d4 denied \d+:locked: .+$/.test(a[1]) ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  { name: 'w-replace-busy', uaeOnly: true, run: async (p, h) => { const b = await b4(p, h); try {
      const err = expectErr(await b.send({ id: 'h1', path: 'Full:Hold.txt', data: hello, mode: 'replace' }), 'busy');
      if (err) return err;
      const a = await b.request(`DIR h2 ${lenp('Full:')}`);
      return a.some((l) => / f 0 [0-9a-f]+ \S+ 8:Hold\.txt /.test(l)) && !a.some((l) => l.includes(' 10:.webadf-rx ')) ? null : `Full: lists ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  // Transfer 2.6, protocol 5 (spec §9): DELETE ... one, and a drawer delete that hides the drawer first.
  { name: 'w-one-on-4', run: async (p, h, ctl) => { const b = await b4(p, h); try {
      return oneLine(await b.request(`DELETE o0 ${lenp('Work:One5.txt')} one`), /^ERR o0 bad 11:bad request$/)
        ?? (hostHolds(ctl, 'One5.txt', '1') ? null : 'deleted on protocol 4');
    } finally { await b.close(); } } },
  { name: 'w5-hello', run: async (p, h) => { const b = await connect(p, h, { v: 5 }); try {
      return b.browse && b.writable ? null : `READY 5 ${b.browse ? 1 : 0} ${b.writable ? 1 : 0}`;
    } finally { await b.close(); } } },
  { name: 'w5-one-file', run: async (p, h, ctl) => { const b = await b5(p, h); try {
      const a = await b.request(`DELETE o1 ${lenp('Work:One5.txt')} one`);
      return a.join('|') === 'DONE o1 1' && !fs.existsSync(onWork(ctl, 'One5.txt')) ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  { name: 'w5-one-empty', run: async (p, h, ctl) => { const b = await b5(p, h); try {
      const a = await b.request(`DELETE o2 ${lenp('Work:Empty5')} one`);
      return a.join('|') === 'DONE o2 1' && !fs.existsSync(onWork(ctl, 'Empty5')) ? null : `got ${JSON.stringify(a)}`;
    } finally { await b.close(); } } },
  { name: 'w5-one-notempty', run: async (p, h, ctl) => { const b = await b5(p, h); try {
      return oneLine(await b.request(`DELETE o3 ${lenp('Work:Full5')} one`), /^ERR o3 notempty \d+:.+$/)
        ?? (hostHolds(ctl, 'Full5/f', 'f') ? null : 'something inside was deleted');
    } finally { await b.close(); } } },
  { name: 'w5-delete-hides', run: async (p, h, ctl) => { const b = await b5(p, h); try {
      const a = await b.request(`DELETE o4 ${lenp('Work:Old5')}`, 120000);
      if (JSON.stringify(a) !== JSON.stringify(['DEL o4 50', 'DONE o4 61'])) return `got ${JSON.stringify(a)}`;
      const left = fs.readdirSync(ctl.work).filter((n) => n === 'Old5' || n.startsWith('.webadf-del-'));
      return left.length ? `left ${left.join(',')}` : null;
    } finally { await b.close(); } } },
  // A refusal mid-way renames the drawer back: Full:Stuck is still Full:Stuck, and nothing hidden is left.
  { name: 'w5-delete-stops', uaeOnly: true, run: async (p, h) => { const b = await b5(p, h); try {
      const a = await b.request(`DELETE o5 ${lenp('Full:Stuck')}`);
      if (!(a.length === 2 && /^DEL o5 [0-2]$/.test(a[0]) && /^ERR o5 denied \d+:locked: .+$/.test(a[1]))) return `got ${JSON.stringify(a)}`;
      const d = await b.request(`DIR o6 ${lenp('Full:')}`);
      return d.some((l) => / d 0 [0-9a-f]+ \S+ 5:Stuck /.test(l)) && !d.some((l) => l.includes('.webadf-del-')) ? null : `Full: lists ${JSON.stringify(d)}`;
    } finally { await b.close(); } } },
  { name: 'w-protocol-3', run: async (p, h, ctl) => { const b = await connect(p, h, { v: 3 }); try {
      if (!b.browse) return 'READY 3 0';
      return oneLine(await b.request(`MKDIR m5 ${lenp('Work:Never')}`), /^ERR m5 readonly 26:writing is off in Transfer$/)
        ?? (fs.existsSync(onWork(ctl, 'Never')) ? 'made on protocol 3' : null);
    } finally { await b.close(); } } },
  // Changing the switch drops the idle connection so the board hears READY 4 1 0 (spec §2.4).
  { name: 'w-off', posixOnly: true, run: async (p, h, ctl) => {
      let b = await b4(p, h);
      ctl.write!(false);
      if (!(await b.closed(5000))) { await b.close(); return 'still open after switching writing off'; }
      b = await connect(p, h, { v: 4 });
      try {
        if (!b.browse || b.writable) return `READY 4 ${b.browse ? 1 : 0} ${b.writable ? 1 : 0} after switching writing off`;
        const a = await b.request(`MKDIR o1 ${lenp('Work:Off')}`);
        if (a.join('|') !== 'ERR o1 readonly 26:writing is off in Transfer') return `got ${JSON.stringify(a)}`;
        const o = await b.send({ id: 'o2', path: 'Work:off.txt', data: hello, mode: 'keep' });
        if (o.ok || o.code !== 'readonly' || o.text !== 'writing is off in Transfer') return `FILE: ${JSON.stringify(o)}`;
        ctl.write!(true);
        if (!(await b.closed(5000))) return 'still open after switching writing on';
      } finally { await b.close(); }
      b = await connect(p, h, { v: 4 });
      try { return b.writable ? null : 'READY 4 1 0 after switching on'; } finally { await b.close(); } } },
];

export async function runWriteScenarios(port: number, ctl: WriteCtl, opts: { host?: string; uae?: boolean; only?: string[] } = {}) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const s of WRITE_SCENARIOS) {
    if (opts.only && !opts.only.includes(s.name)) continue;
    if (s.posixOnly && opts.uae) continue;
    if (s.uaeOnly && !opts.uae) continue;
    try { const err = await s.run(port, opts.host ?? '127.0.0.1', ctl); out.push({ name: s.name, ok: err === null, detail: err ?? '' }); }
    catch (e) { out.push({ name: s.name, ok: false, detail: String(e) }); }
  }
  return out;
}

export async function runBrowseScenarios(port: number, ctl: BrowseCtl, opts: { host?: string; uae?: boolean; only?: string[] } = {}) {
  const out: { name: string; ok: boolean; detail: string }[] = [];
  for (const s of BROWSE_SCENARIOS) {
    if (opts.only && !opts.only.includes(s.name)) continue;
    if (s.posixOnly && opts.uae) continue;
    try { const err = await s.run(port, opts.host ?? '127.0.0.1', ctl); out.push({ name: s.name, ok: err === null, detail: err ?? '' }); }
    catch (e) { out.push({ name: s.name, ok: false, detail: String(e) }); }
  }
  return out;
}
