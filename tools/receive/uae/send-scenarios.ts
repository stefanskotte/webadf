// The board's side of uae-test.sh's send mode: one step per `Transfer SEND` line of the startup-sequence it wrote, in
// the same order. Each step waits for that run to listen on 6800, plays the board, and closes; then the logs (one per
// run, with its return code) and ENVARC:webadf/BoardKey are checked.
// Usage: tsx tools/receive/uae/send-scenarios.ts --hd <the emulated Work: folder>
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_KEY, BOARD_KEY2, UploadStore, connect, rawConnect, type UploadResult } from '../fake-board';

const hd = process.argv[process.argv.indexOf('--hd') + 1];
const up = (n: string) => fs.readFileSync(path.join(hd, 'Up', n));
async function listening(ms = 180000) {
  const t0 = Date.now();
  for (;;) {
    try { const s = await rawConnect(6800); s.destroy(); return; }
    catch { if (Date.now() - t0 > ms) throw new Error('Transfer never listened'); await new Promise((r) => setTimeout(r, 500)); }
  }
}
// The run before may still hold the port for a moment as it quits: retry until a READY comes back.
async function board(key = BOARD_KEY, v: 1 | 2 = 2) {
  const t0 = Date.now();
  for (;;) {
    await listening();
    try { return await connect(6800, '127.0.0.1', { v, key }); }
    catch (e) { if (Date.now() - t0 > 180000) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
}
const same = (r: UploadResult, want: Buffer) => (r.ok && Buffer.compare(r.data, want) === 0 ? null : `got ${JSON.stringify({ ...r, data: r.ok ? r.data.length : undefined })}`);
const store = new UploadStore();

const steps: { name: string; run: () => Promise<string | null> }[] = [
  { name: 's01 small (first contact: key saved)', run: async () => { const b = await board(); try { return same(await b.takeUpload({ timeoutMs: 60000 }), up('Hello.txt')); } finally { await b.close(); } } },
  { name: 's02 4 MB', run: async () => { const b = await board(); const t0 = Date.now();
      try { return same(await b.takeUpload({ timeoutMs: 900000 }), up('Big.bin')); } finally { console.log(`  4 MB up in ${((Date.now() - t0) / 1000).toFixed(0)} s`); await b.close(); } } },
  { name: 's03 drawer', run: async () => { const b = await board();
      try { const got = [(await b.takeUpload({ timeoutMs: 60000 })).path, (await b.takeUpload({ timeoutMs: 60000 })).path].sort();
            return JSON.stringify(got) === JSON.stringify(['Mods/a.mod', 'Mods/sub/b.mod']) ? null : `got ${got}`; } finally { await b.close(); } } },
  { name: 's03b drawer with a trailing slash (Mods/)', run: async () => { const b = await board();
      try { const got = [(await b.takeUpload({ timeoutMs: 60000 })).path, (await b.takeUpload({ timeoutMs: 60000 })).path].sort();
            return JSON.stringify(got) === JSON.stringify(['Mods/a.mod', 'Mods/sub/b.mod']) ? null : `got ${got}`; } finally { await b.close(); } } },
  { name: 's04 resume: the first try is cut', run: async () => { const b = await board();
      const r = await b.takeUpload({ store, dropAfterChunks: 2, timeoutMs: 60000 }); return !r.ok && r.code === 'dropped' ? null : JSON.stringify(r); } },
  { name: 's05 resume: the rest', run: async () => { const b = await board();
      try { const r = await b.takeUpload({ store, timeoutMs: 120000 }); return r.offset === 32768 ? same(r, up('Resume.bin')) : `resumed at ${r.offset}`; } finally { await b.close(); } } },
  { name: 's06 CRC fault', run: async () => { const b = await board(); try { const r = await b.takeUpload({ crcFault: true, timeoutMs: 60000 }); return !r.ok && r.code === 'crc' ? null : JSON.stringify(r); } finally { await b.close(); } } },
  // PF11: not just "a PUT came": it is this run's file, and the NO ends the run -- Transfer closes at once, with no retry
  // and no other PUT (a Transfer that ignored the NO would sit in the PUT until the 180 s silence).
  { name: 's07 refused', run: async () => { const b = await board();
      try { const r = await b.takeUpload({ refuse: { code: 'full', text: "the web app's area is full" }, timeoutMs: 60000 });
            if (r.path !== 'Refused.bin' || r.size !== 1) return `refused the wrong PUT ${JSON.stringify(r)}`;
            const t0 = Date.now(); const l = await b.maybeLine(15000);
            if (l !== null) return `got ${JSON.stringify(l)} after the NO`;
            return Date.now() - t0 < 14000 ? null : 'Transfer kept the connection open after the NO'; } finally { await b.close(); } } },
  { name: 's08 Latin-1 name', run: async () => { const b = await board();
      try { const r = await b.takeUpload({ timeoutMs: 60000 }); return r.path === 'Café.txt' ? same(r, up('Café.txt')) : `path ${JSON.stringify(r.path)}`; } finally { await b.close(); } } },
  { name: 's09 a protocol 1 board', run: async () => { const b = await board(BOARD_KEY, 1); try { const l = await b.maybeLine(5000); return l === null ? null : `got ${l}`; } finally { await b.close(); } } },
  { name: 's10 another key', run: async () => { const b = await board(BOARD_KEY2); try { const l = await b.maybeLine(5000); return l === null ? null : `got ${l}`; } finally { await b.close(); } } },
  { name: 's11 SEND TRUST', run: async () => { const b = await board(BOARD_KEY2); try { return same(await b.takeUpload({ timeoutMs: 60000 }), up('Hello.txt')); } finally { await b.close(); } } },
  { name: 's12 hand-off to a running Transfer', run: async () => { const b = await board(BOARD_KEY2); try { return same(await b.takeUpload({ timeoutMs: 120000 }), up('Hello.txt')); } finally { await b.close(); } } },
];

const logs: [string, RegExp[]][] = [
  ['s01', [/Hello\.txt {2}21 bytes {2}OK/, /rc=0/]], ['s02', [/Big\.bin {2}4194304 bytes {2}OK/, /rc=0/]],
  ['s03', [/Mods\/a\.mod {2}1 bytes {2}OK/, /Mods\/sub\/b\.mod {2}1 bytes {2}OK/, /rc=0/]], ['s03b', [/Mods\/a\.mod {2}1 bytes {2}OK/, /Mods\/sub\/b\.mod {2}1 bytes {2}OK/, /rc=0/]],
  ['s04', [/ERR connection lost/, /rc=10/]],
  ['s05', [/Resume\.bin {2}100000 bytes {2}OK/, /rc=0/]], ['s06', [/ERR damaged on the way/, /rc=10/]],
  ['s07', [/ERR the web app's area is full/, /rc=10/]], ['s08', [/bytes {2}OK/, /rc=0/]],
  ['s09', [/cannot receive files \(update to 1\.19\.0\)/, /rc=10/]], ['s10', [/Another board or computer connected -- not sending/, /rc=10/]],
  ['s11', [/Trusted board FEDC/, /rc=0/]], ['s12', [/Hello\.txt {2}21 bytes {2}OK/, /rc=0/]],
  // The direction is RECEIVE or SEND (2.1): both is refused before anything starts; and the version names the program.
  ['s13', [/^Transfer: RECEIVE or SEND, not both$/m, /rc=10/]], ['ver', [/Transfer 2\.1/]],
];

let fail = 0;
for (const s of steps) {
  let err: string | null;
  try { err = await s.run(); } catch (e) { err = String(e); }
  console.log(`${err === null ? 'PASS' : 'FAIL'} ${s.name}${err ? ': ' + err : ''}`);
  if (err !== null) fail++;
}
for (let i = 0; i < 120 && !fs.existsSync(path.join(hd, 'done')); i++) await new Promise((r) => setTimeout(r, 1000));
for (const [log, want] of logs) {
  const text = fs.existsSync(path.join(hd, `${log}.log`)) ? fs.readFileSync(path.join(hd, `${log}.log`), 'latin1') : '';
  const missing = want.filter((re) => !re.test(text));
  console.log(`${missing.length ? 'FAIL' : 'PASS'} ${log}.log${missing.length ? `: lacks ${missing.join(', ')} -- ${JSON.stringify(text)}` : ''}`);
  if (missing.length) fail++;
}
const key = fs.existsSync(path.join(hd, 'EnvArc/webadf/BoardKey')) ? fs.readFileSync(path.join(hd, 'EnvArc/webadf/BoardKey'), 'latin1').trim() : '';
console.log(`${key === BOARD_KEY2 ? 'PASS' : 'FAIL'} ENVARC:webadf/BoardKey is the key TRUST accepted (${key})`);
if (key !== BOARD_KEY2) fail++;
process.exit(fail ? 1 : 0);
