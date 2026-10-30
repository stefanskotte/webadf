import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScenarios, runUploadScenarios, runBrowseScenarios, makeBrowseFixture } from './scenarios';
import { connect, rawConnect } from './fake-board';

const here = path.dirname(new URL(import.meta.url).pathname);
let bin: string; let tmp: string;

function start(dir: string, env: Record<string, string> = {}, keyFile?: string): Promise<{ proc: ChildProcess; port: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [dir, '0', ...(keyFile ? [keyFile] : [])], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: string[] = []; let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l);
        const m = /^LISTEN (\d+)$/.exec(l); if (m) resolve({ proc, port: Number(m[1]), lines }); }
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error('rx_posix did not listen')), 5000);
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'receive-'));
  bin = path.join(tmp, 'rx_posix');
  execFileSync('cc', ['-std=c99', '-O1', '-Wall', '-Wextra', '-Werror', '-I', path.join(here, 'core'), '-o', bin,
    path.join(here, 'core/rx_crc.c'), path.join(here, 'core/rx_names.c'), path.join(here, 'core/rx_proto.c'),
    path.join(here, 'posix/rx_posix.c')]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('Receive (POSIX build) against the fake board', () => {
  it('passes every shared scenario', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'out-'));
    const { proc, port, lines } = await start(dir);
    try {
      const res = await runScenarios(port, dir);
      expect(res.filter((r) => !r.ok)).toEqual([]);
      expect(lines).toContain('META Script 40 a comment');
    } finally { proc.kill(); }
  }, 60000);

  it('sends files up: small, Latin-1, 4 MB, a drawer, a resume, a CRC fault, a refusal, a v1 board, a key change, a cancel', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'up-'));
    const src = fs.mkdtempSync(path.join(tmp, 'src-'));
    const keyFile = path.join(tmp, 'BoardKey');
    const { proc, port, lines } = await start(dir, {}, keyFile);
    const ctl = {
      dir: src, lines: () => lines,
      send: (p: string) => proc.stdin!.write(`SEND ${p}\n`),
      trust: () => proc.stdin!.write('TRUST\n'),
      cancel: (t: string) => proc.stdin!.write(`CANCEL ${t}\n`),
    };
    try {
      const res = await runUploadScenarios(port, ctl);
      expect(res.filter((r) => !r.ok)).toEqual([]);
      expect(res).toHaveLength(10);
      expect(fs.readFileSync(keyFile, 'utf8').trim()).toBe('fedcba9876543210fedcba9876543210');   // TRUST saved the second key
      expect(lines).toContain('TRUST new 0123');                                                    // first contact
    } finally { proc.kill(); }
  }, 300000);

  it('answers VOLS, DIR and GET with browsing on; a request waits behind a file; switching off reconnects', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'br-'));
    const src = fs.mkdtempSync(path.join(tmp, 'brsrc-'));
    const vols = makeBrowseFixture(fs.mkdtempSync(path.join(tmp, 'vols-')));
    const { proc, port, lines } = await start(dir, { RX_VOLS: vols, RX_BROWSE: '1' }, path.join(tmp, 'BrowseKey'));
    const ctl = {
      dir: src,
      send: (p: string) => proc.stdin!.write(`SEND ${p}\n`),
      browse: (on: boolean) => proc.stdin!.write(`BROWSE ${on ? 1 : 0}\n`),
    };
    try {
      const res = await runBrowseScenarios(port, ctl);
      expect(res.filter((r) => !r.ok)).toEqual([]);
      expect(res).toHaveLength(11);
      expect(lines).toContain('REQ dir Work:Big 1000 cut ok');
      expect(lines).toContain('REQ get Work:Programs/a.txt 0 ok');
    } finally { proc.kill(); }
  }, 300000);

  it('refuses a file larger than the free space', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'small-'));
    const { proc, port } = await start(dir, { RX_FREE_BYTES: '20000' });
    try {
      const b = await connect(port);
      const o = await b.send({ id: 'x1', path: 'Big', data: Buffer.alloc(30000) }); await b.close();
      expect(o).toEqual({ id: 'x1', ok: false, code: 'space', text: 'not enough space' });
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { proc.kill(); }
  });

  it('drops a client that goes silent, so the board is not refused as busy for ever', async () => {
    // A browser or scanner sends "GET /" and waits; a board that rebooted never sends FIN (review finding 2).
    const dir = fs.mkdtempSync(path.join(tmp, 'idle-'));
    const { proc, port } = await start(dir, { RX_IDLE_SECS: '2' });
    try {
      const idle = await rawConnect(port);
      idle.write('GET / HTTP/1.0\r\n');
      await new Promise((r) => setTimeout(r, 3500));
      const b = await connect(port);
      const o = await b.send({ id: 'i1', path: 'AfterIdle.txt', data: Buffer.from('x') }); await b.close();
      idle.destroy();
      expect(o).toEqual({ id: 'i1', ok: true, savedAs: 'AfterIdle.txt' });
    } finally { proc.kill(); }
  }, 15000);

  it('answers ERR folder when the folder vanished', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'gone-'));
    const { proc, port } = await start(dir);
    try {
      fs.rmSync(dir, { recursive: true });
      const b = await connect(port);
      const o = await b.send({ id: 'y1', path: 'X', data: Buffer.from('x') }); await b.close();
      expect(o).toMatchObject({ ok: false, code: 'folder' });
    } finally { proc.kill(); }
  });
});
