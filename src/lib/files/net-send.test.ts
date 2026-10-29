import { describe, it, expect } from 'vitest';
import { netDropRefusal, sendToBoard } from './net-send';

const MB = 1024 * 1024;

describe('netDropRefusal (C2: files from the computer dropped on NET:/<board>)', () => {
  it('null when the drop fits the board queue; else the words, naming the file', () => {
    expect(netDropRefusal([{ path: 'a.txt', size: 10 }], { files: 0, bytes: 0 })).toBeNull();
    expect(netDropRefusal([], { files: 0, bytes: 0 })).toBe('Nothing to send — the drop held no files.');
    expect(netDropRefusal([{ path: 'a.txt', size: 10 }], { files: 32, bytes: 0 }))
      .toBe("The board's queue holds 32 files / 16 MB; wait for it to empty or cancel some.");
    expect(netDropRefusal([{ path: 'a', size: 1 }, { path: 'Mods/big.mod', size: 5 * MB }], { files: 0, bytes: 0 }))
      .toBe('Mods/big.mod is over 4 MB — nothing was sent');
    expect(netDropRefusal([{ path: 'Empty.txt', size: 0 }], { files: 0, bytes: 0 })).toBe('Empty.txt is empty — nothing was sent');
  });
});

describe('sendToBoard', () => {
  const file = (s: string) => new File([s], 'x');
  it('posts each file by its path to the board, one at a time, and counts what queued', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return url.includes('bad')
        ? new Response(JSON.stringify({ error: 'bad_name' }), { status: 400, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ id: 't' }), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const r = await sendToBoard('b 1', [{ path: 'Mods/a.mod', file: file('a') }, { path: 'bad:', file: file('b') }], fetchImpl);
    expect(calls).toEqual(['/api/transfers?deviceId=b%201&name=Mods%2Fa.mod', '/api/transfers?deviceId=b%201&name=bad%3A']);
    expect(r).toEqual({ queued: 1, failed: [{ path: 'bad:', why: 'That name cannot be used on the Amiga.' }], stopped: null });
  });

  it('a full queue stops the rest; a network error is said', async () => {
    const full = async () => new Response(JSON.stringify({ error: 'queue_full' }), { status: 409, headers: { 'content-type': 'application/json' } });
    const r = await sendToBoard('b1', [{ path: 'a', file: file('a') }, { path: 'b', file: file('b') }], full);
    expect(r.queued).toBe(0);
    expect(r.stopped).toBe("The board's queue holds 32 files / 16 MB; wait for it to empty or cancel some.");
    const down = async (): Promise<Response> => { throw new Error('offline'); };
    const d = await sendToBoard('b1', [{ path: 'a', file: file('a') }], down);
    expect(d.failed).toEqual([{ path: 'a', why: 'The upload did not finish. Check the connection and try again.' }]);
  });
});
