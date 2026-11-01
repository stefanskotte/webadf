// uae-test.sh's flip mode (Transfer 2.7, plan 2026-11-01 Task 2): the window's Write box is unticked (by poke, on the
// Amiga) while a 400 KB `replace` of Work:Keep.txt is received. The FILE must end `ERR <id> readonly`, Keep.txt keep
// its old bytes, no .webadf-rx stay, and the board reconnect to hear READY 5 1 0.
// Usage: tsx tools/receive/uae/flip-scenario.ts --hd <the emulated Work: folder> [--shots <dir> --ks <ks>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_KEY, connect, rawConnect } from '../fake-board';

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const hd = arg('--hd')!;
const shots = arg('--shots'); const ks = arg('--ks') ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails++; };
const until = async (f: () => boolean, ms: number) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(500); } return true; };
function shot(name: string) {
  if (!shots) return;
  try {
    const id = execFileSync('swift', [new URL('window-id.swift', import.meta.url).pathname, 'FS-UAE']).toString().trim();
    execFileSync('screencapture', ['-x', '-o', `-l${id}`, path.join(shots, `transfer-2.7-${ks}-${name}.png`)]);
    console.log(`  screenshot transfer-2.7-${ks}-${name}.png`);
  } catch (e) { console.log(`  no screenshot: ${e}`); }
}
async function listening(ms = 180000) {
  const t0 = Date.now();
  for (;;) {
    try { const s = await rawConnect(6800); s.destroy(); return; }
    catch { if (Date.now() - t0 > ms) throw new Error('Transfer never listened'); await sleep(500); }
  }
}

const old = fs.readFileSync(path.join(hd, 'Keep.txt'));
await listening();
await sleep(4000);
shot('rw');   // Read and Write ticked, before the flip
const b = await connect(6800, '127.0.0.1', { v: 5, key: BOARD_KEY });
const data = Buffer.alloc(400000, 0x5a);
setTimeout(() => fs.writeFileSync(path.join(hd, 'go'), 'go\n'), 3000);   // poke on the Amiga unticks Write now
const t0 = Date.now();
const r = await b.send({ id: 'flip1', path: 'Work:Keep.txt', data, mode: 'replace' }, { chunk: 4096, delayMs: 100 });
console.log(`  answer after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(r)}`);
check(!r.ok && r.code === 'readonly' && r.text === 'writing is off in Transfer', 'the FILE ends ERR flip1 readonly writing is off in Transfer');
check(Buffer.compare(fs.readFileSync(path.join(hd, 'Keep.txt')), old) === 0, 'Keep.txt keeps its old bytes');
check(!fs.existsSync(path.join(hd, '.webadf-rx')), 'no .webadf-rx left in Work:');
check(await until(() => fs.existsSync(path.join(hd, 'fdone')), 60000), 'poke finished');
const rd = (n: string) => (fs.existsSync(path.join(hd, n)) ? fs.readFileSync(path.join(hd, n), 'latin1').trim() : '(none)');
check(rd('f2.log') === 'off', `the Write box is unticked (${rd('f2.log')})`);
await b.close();
// The switch changed: once idle, Transfer closes and the board hears the new flags.
let ready = '';
for (let i = 0; i < 20 && !ready; i++) {
  try { const s = await rawConnect(6800);
        ready = await new Promise<string>((res) => { let got = ''; s.on('data', (d) => { got += d.toString('latin1'); if (got.includes('\n')) { s.destroy(); res(got.trim()); } });
                                                       s.on('close', () => res(got.trim())); s.write(`WEBADF 5 ${BOARD_KEY}\n`); setTimeout(() => { s.destroy(); res(got.trim()); }, 5000); });
  } catch { await sleep(1000); }
}
check(ready === 'READY 5 1 0', `a new connection hears ${ready}`);
fs.writeFileSync(path.join(hd, 'go2'), 'go\n');   // poke unticks Read now
check(await until(() => fs.existsSync(path.join(hd, 'fdone2')), 60000), 'Read unticked');
check(rd('f4.log') === 'off' && rd('f5.log') === 'off,disabled', `Read off (${rd('f4.log')}), Write off and greyed (${rd('f5.log')})`);
await sleep(2000);
shot('ro');
process.exit(fails ? 1 : 0);
