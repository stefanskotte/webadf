import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { backendContract } from './backend.contract';
import { localBackend } from './local';

backendContract('local', async () => localBackend(mkdtempSync(join(tmpdir(), 'webadf-blobs-'))));

it('local: a failed stream leaves nothing under the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webadf-blobs-'));
  const b = localBackend(dir);
  const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('client went away')); } });
  await expect(b.put('adf/ff', broken, { contentType: 'x/y', overwrite: false })).rejects.toThrow();
  expect(await b.head('adf/ff')).toBeNull();
  expect(readdirSync(join(dir, 'adf')).filter((f) => !f.startsWith('.tmp-'))).toEqual([]);
});

// Open descriptors, counted the way both macOS and Linux expose them. A
// FileHandle that is never closed stays in this list until GC (Node's
// readableWebStream() does NOT close its handle by default -- measured on
// Node 25.8: one descriptor leaked per read, whether read to the end or
// cancelled), so a leak shows up as a growing count.
const openFds = () => readdirSync('/dev/fd').length;
const settle = () => new Promise((r) => setTimeout(r, 20));

it.skipIf(process.platform === 'win32')('local: reading to the end, cancelling, or never reading all leave no file open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webadf-blobs-'));
  const b = localBackend(dir);
  await b.put('adf/big', new Uint8Array(1 << 20).fill(7), { contentType: 'x/y', overwrite: false });
  await settle();
  const before = openFds();

  for (let i = 0; i < 20; i++) {
    const o = await b.get('adf/big');
    expect((await new Response(o!.stream).arrayBuffer()).byteLength).toBe(1 << 20);
  }
  for (let i = 0; i < 20; i++) {
    const o = await b.get('adf/big');
    const r = o!.stream.getReader();
    await r.read();
    await r.cancel();
  }
  // Never read at all (a size check): must open nothing. On Node 25 an open
  // FileHandle reaching GC is an uncaught ERR_INVALID_STATE, not a warning.
  for (let i = 0; i < 20; i++) {
    expect((await b.get('adf/big'))?.sizeBytes).toBe(1 << 20);
  }
  await settle();
  // A small tolerance for descriptors the test runner itself opens or closes
  // meanwhile; a leak here is 20-60 descriptors (one per get).
  expect(openFds()).toBeLessThanOrEqual(before + 3);
});

it('local: lists only real objects, never temp files or sidecars', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webadf-blobs-'));
  const b = localBackend(dir);
  await b.put('adf/g1', new Uint8Array([1]), { contentType: 'x/y', overwrite: false });
  mkdirSync(join(dir, 'adf'), { recursive: true });
  writeFileSync(join(dir, 'adf', '.tmp-abandoned'), 'x');
  const keys: string[] = [];
  for await (const o of b.list('adf/')) keys.push(o.key);
  expect(keys).toEqual(['adf/g1']);
});
