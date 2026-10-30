import { describe, expect, it } from 'vitest';
import { amigaDateIso, amigaPathOf, newRequestId, parseAnswerLine, requestLine, volumeLabel, type VolumeInfo } from './remote-wire';

describe('requestLine', () => {
  it('writes VOLS, DIR and GET with length-prefixed Latin-1 paths', () => {
    expect(requestLine({ id: 'r1', kind: 'vols', amigaPath: '' })).toBe('VOLS r1\n');
    expect(requestLine({ id: 'r1', kind: 'dir', amigaPath: 'Work:Programs' })).toBe('DIR r1 13:Work:Programs\n');
    expect(requestLine({ id: 'r1', kind: 'get', amigaPath: 'Work:Würfel Spiel/a.lha' })).toBe('GET r1 23:Work:Würfel Spiel/a.lha\n');
  });
});

describe('parseAnswerLine', () => {
  it('reads VOL, ENT, DONE (with and without cut), ERR, GOT', () => {
    expect(parseAnswerLine('r1', 'VOL r1 4:Work 4:DH1: 104857600 41943040 17000.600.0')).toEqual({ t: 'vol',
      v: { name: 'Work', device: 'DH1:', size: 104857600, free: 41943040, date: amigaDateIso(17000, 600, 0) } });
    expect(parseAnswerLine('r1', 'ENT r1 f 2210 0f 16500.0.50 6:ReadMe 0:')).toEqual({ t: 'ent',
      e: { name: 'ReadMe', dir: false, size: 2210, protection: 0x0f, date: amigaDateIso(16500, 0, 50), comment: '' } });
    expect(parseAnswerLine('r1', 'ENT r1 d 0 0 16500.0.0 5:My Dr 3:a b')).toMatchObject({ t: 'ent', e: { name: 'My Dr', dir: true, comment: 'a b' } });
    expect(parseAnswerLine('r1', 'DONE r1 3')).toEqual({ t: 'done', count: 3, cut: false });
    expect(parseAnswerLine('r1', 'DONE r1 1000 cut')).toEqual({ t: 'done', count: 1000, cut: true });
    expect(parseAnswerLine('r1', 'ERR r1 notfound 16:object not found')).toEqual({ t: 'err', code: 'notfound', text: 'object not found' });
    expect(parseAnswerLine('r1', 'GOT r1 12')).toEqual({ t: 'got', tag: '12' });
  });
  it('refuses malformed lines and other ids', () => {
    expect(parseAnswerLine('r1', 'VOL r2 4:Work 4:DH1: 1 1 1.1.1')).toBeNull();
    expect(parseAnswerLine('r1', 'ENT r1 x 1 0 1.1.1 1:a 0:')).toBeNull();
    expect(parseAnswerLine('r1', 'ENT r1 f 1 0 1.1.1 9:a 0:')).toBeNull();      // length says 9, one character follows
    expect(parseAnswerLine('r1', 'ENT r1 f 1 0 1.1.1 1:/ 0:')).toBeNull();      // a name with '/' or ':' is not a name
    expect(parseAnswerLine('r1', 'DONE r1 -1')).toBeNull();
    expect(parseAnswerLine('r1', 'ERR r1 bogus! 1:x')).toBeNull();
    expect(parseAnswerLine('r1', 'HELLO')).toBeNull();
  });
});

describe('amigaPathOf', () => {
  it('turns NET: segments below the board into an Amiga path', () => {
    expect(amigaPathOf(['Work'])).toEqual({ volume: 'Work', amigaPath: 'Work:' });
    expect(amigaPathOf(['RAM Disk', 'T'])).toEqual({ volume: 'RAM Disk', amigaPath: 'RAM Disk:T' });
    expect(amigaPathOf(['Work', 'Würfel Spiel', 'a.lha'])).toEqual({ volume: 'Work', amigaPath: 'Work:Würfel Spiel/a.lha' });
    expect(amigaPathOf(['Empty (DF1:)', 'c'])).toEqual({ volume: 'Empty (DF1:)', amigaPath: 'Empty (DF1:):c' });
  });
  it('refuses names AmigaDOS would not take', () => {
    expect(amigaPathOf([])).toBeNull();
    expect(amigaPathOf(['Work', 'a:b'])).toBeNull();
    expect(amigaPathOf(['Work', 'x'.repeat(31)])).toBeNull();
  });
});

describe('volumeLabel', () => {
  const v = (name: string, device: string): VolumeInfo => ({ name, device, size: 0, free: 0, date: '' });
  it('adds the device to a duplicate name, and always to a volume named Queue', () => {
    const all = [v('Empty', 'DF0:'), v('Empty', 'DF1:'), v('Work', 'DH1:'), v('Queue', 'DH2:')];
    expect(all.map((x) => volumeLabel(x, all))).toEqual(['Empty (DF0:)', 'Empty (DF1:)', 'Work', 'Queue (DH2:)']);
    expect(volumeLabel(v('empty', 'DF0:'), [v('empty', 'DF0:'), v('EMPTY', 'DF1:')])).toBe('empty (DF0:)');
  });
});

describe('newRequestId', () => {
  it('is 22 base64url characters and differs each time', () => {
    const a = newRequestId(); const b = newRequestId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });
});
