import { describe, it, expect } from 'vitest';
import { cleanAmigaPath, formatQueue, latin1Len, SEND_QUEUE_BYTES, type QueueRow } from './transfers';

describe('cleanAmigaPath', () => {
  it('keeps a plain name and folders', () => {
    expect(cleanAmigaPath('Hello.txt')).toBe('Hello.txt');
    expect(cleanAmigaPath('mods/axelf.mod')).toBe('mods/axelf.mod');
  });
  it('drops parent and empty parts, never escaping the folder', () => {
    expect(cleanAmigaPath('../evil/Café.LHA')).toBe('evil/Café.LHA');
    expect(cleanAmigaPath('/abs//x/./y')).toBe('abs/x/y');
    expect(cleanAmigaPath('../..')).toBeNull();
  });
  it('replaces colons and non-Latin-1, removes control characters', () => {
    expect(cleanAmigaPath('DH0:x')).toBe('DH0_x');
    expect(cleanAmigaPath('日本.txt')).toBe('__.txt');
    expect(cleanAmigaPath('a\u0007b')).toBe('ab');
  });
  it('cuts a part to 30 bytes and keeps a short extension', () => {
    expect(cleanAmigaPath('A'.repeat(40) + '.lha')).toBe('A'.repeat(26) + '.lha');
    expect(cleanAmigaPath('B'.repeat(40))).toBe('B'.repeat(30));
  });
  it('refuses a result over 255 bytes', () => {
    expect(cleanAmigaPath(Array.from({ length: 10 }, () => 'C'.repeat(30)).join('/'))).toBeNull();
  });
});

const row = (i: number, path = `File${i}.bin`): QueueRow =>
  ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, sizeBytes: 1000 + i, crc32: 0xcbf43926, protection: 0x40, path, comment: '' });

describe('formatQueue', () => {
  it('writes NEXT and LIST in the protocol form', () => {
    const r = row(1, 'Café.txt');
    const t = formatQueue(r, [r]);
    expect(t).toBe(`NEXT ${r.id} 1001 cbf43926 40 8:Café.txt 0:\nLIST 1\n${r.id} 1001 8:Café.txt\n`);
    expect(latin1Len('Café.txt')).toBe(8);
  });
  it('says NEXT - with an empty list', () => {
    expect(formatQueue(null, [])).toBe('NEXT -\nLIST 0\n');
  });
  it('drops trailing LIST lines to stay in budget, never cutting a line', () => {
    const rows = Array.from({ length: 32 }, (_, i) => row(i, 'D'.repeat(30) + '/' + 'E'.repeat(30) + '/' + 'F'.repeat(30) + '/' + 'G'.repeat(30) + '/' + 'H'.repeat(30) + '/' + 'I'.repeat(30) + '/' + 'J'.repeat(30) + '/' + `n${i}`));
    const t = formatQueue(rows[0], rows);
    expect(Buffer.byteLength(t, 'latin1')).toBeLessThanOrEqual(SEND_QUEUE_BYTES);
    const n = Number(/\nLIST (\d+)\n/.exec(t)![1]);
    expect(n).toBeLessThan(32);
    expect(t.trimEnd().split('\n').length).toBe(2 + n);
  });
});
