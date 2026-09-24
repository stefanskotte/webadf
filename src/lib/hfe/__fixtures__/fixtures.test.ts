import { describe, it, expect } from 'vitest';
import { fixture, sideRange } from './load';
import { sparseAdf } from './source';

const ascii = (b: Uint8Array, n: number) => String.fromCharCode(...b.subarray(0, n));
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

describe('committed HFE fixtures (Greaseweazle, measured 2026-09-24)', () => {
  it('clean is HFE v1, 80 cylinders, 2 sides, encoding 0xFF, 253 kbit/s', () => {
    const b = fixture('clean');
    expect(ascii(b, 8)).toBe('HXCPICFE');
    expect([b[8], b[9], b[10], b[11], u16(b, 12)]).toEqual([0, 80, 2, 0xff, 253]);
    expect(b.length).toBe(2_049_024);
    expect(sideRange(b, 0, 0).sideLen).toBe(12_668);
  });

  it('v3 carries the HXCHFEV3 signature (and formatrevision 0 — the revision byte alone cannot spot it)', () => {
    const b = fixture('v3');
    expect(ascii(b, 8)).toBe('HXCHFEV3');
    expect(b[8]).toBe(0);
  });

  it('pc is an HFE v1 of a 720 KB IBM disk at 250 kbit/s', () => {
    const b = fixture('pc');
    expect(ascii(b, 8)).toBe('HXCPICFE');
    expect([b[9], b[10], b[11], u16(b, 12)]).toEqual([80, 2, 0xff, 250]);
  });

  it('sparseAdf is deterministic and every sector is distinct', () => {
    const a = sparseAdf();
    expect(a).toEqual(sparseAdf());
    const heads = new Set<string>();
    for (let i = 0; i < 1760; i++) heads.add(Buffer.from(a.subarray(i * 512 + 480, i * 512 + 496)).toString('hex'));
    expect(heads.size).toBe(1760);
  });
});
