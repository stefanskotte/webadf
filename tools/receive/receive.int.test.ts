import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScenarios } from './scenarios';
import { connect } from './fake-board';

const here = path.dirname(new URL(import.meta.url).pathname);
let bin: string; let tmp: string;

function start(dir: string, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; port: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [dir, '0'], { env: { ...process.env, ...env } });
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
