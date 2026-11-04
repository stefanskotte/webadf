import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSysconf, sysconfDefaults, sysconfSchema, type SysconfSettings } from './sysconf';

const fixture = new Uint8Array(readFileSync(new URL('./sysconf.fixture.bin', import.meta.url)));
const differing = (a: Uint8Array, b: Uint8Array) => [...a.keys()].filter((i) => a[i] !== b[i]);
const changed = (o: Partial<SysconfSettings>) =>
  differing(buildSysconf(sysconfDefaults()), buildSysconf({ ...sysconfDefaults(), ...o }));

describe('buildSysconf', () => {
  it('the defaults are what mksysconfig.py writes, byte for byte', () => {
    expect(buildSysconf(sysconfDefaults())).toEqual(fixture);
  });
  it('is always 232 bytes', () => expect(buildSysconf({ ...sysconfDefaults(), fontHeight: 9 }).length).toBe(232));
  it.each([
    [{ fontHeight: 9 }, [0]],
    [{ interlace: true }, [185]],
    [{ viewX: 3 }, [118]], [{ viewY: -3 }, [119]],
    [{ extraRows: 2 }, [216]], [{ extraColumns: -2 }, [217]],
    [{ mouseTicks: 4 }, [109]],
    [{ acceleration: true }, [124]],
    [{ keySpeedUs: 60000 }, [10, 11]],
    [{ doubleClickUs: 2020000 }, [23]],
  ])('%o changes only its own bytes', (o, at) => expect(changed(o as Partial<SysconfSettings>)).toEqual(at));
  it('stores a colour at its word', () => {
    const b = buildSysconf({ ...sysconfDefaults(), colors: [0x123, 0, 0xFFF, 0x68B], pointerColors: [0xABC, 0, 0xEEC] });
    expect([...b.subarray(110, 112)]).toEqual([0x01, 0x23]);
    expect([...b.subarray(102, 104)]).toEqual([0x0A, 0xBC]);
  });
  it('splits a time into seconds and microseconds', () => {
    const b = buildSysconf({ ...sysconfDefaults(), keyDelayUs: 1500000 });
    const v = new DataView(b.buffer, b.byteOffset);
    expect([v.getUint32(12), v.getUint32(16)]).toEqual([1, 500000]);
  });
  it('stores a hot spot as a negative offset', () => {
    expect([...buildSysconf(sysconfDefaults()).subarray(100, 102)]).toEqual([0xFF, 0x00]);   // -1, 0: pixel (0, 0)
    expect([...buildSysconf({ ...sysconfDefaults(), hotSpot: { x: 15, y: 15 } }).subarray(100, 102)]).toEqual([0xF0, 0xF1]);   // -16, -15
  });
  it('draws a pointer into two bitplanes, between its control words', () => {
    const pointer = Array.from({ length: 16 }, () => '.'.repeat(16));
    pointer[0] = 'RKW' + '.'.repeat(13);
    const b = buildSysconf({ ...sysconfDefaults(), pointer });
    const v = new DataView(b.buffer, b.byteOffset);
    expect(v.getUint32(28)).toBe(0);                     // the control words
    expect(v.getUint16(32)).toBe(0b1010000000000000);    // plane 0: R, W
    expect(v.getUint16(34)).toBe(0b0110000000000000);    // plane 1: K, W
    expect(v.getUint32(96)).toBe(0);                     // the end words
  });
  it('does not share its defaults between calls', () => {
    const a = sysconfDefaults(); a.pointer[0] = 'x'; a.colors[0] = 1;
    expect(sysconfDefaults().pointer[0]).toBe('KK..............');
    expect(sysconfDefaults().colors[0]).toBe(0xAAA);
  });
});

describe('sysconfSchema', () => {
  it.each([
    ['a fraction', { viewX: 1.5 }], ['out of range', { viewX: 17 }], ['mouse speed 0', { mouseTicks: 0 }], ['mouse speed 3', { mouseTicks: 3 }],
    ['font 10', { fontHeight: 10 }], ['a short pointer', { pointer: Array(15).fill('.'.repeat(16)) }],
    ['a bad ink', { pointer: Array(16).fill('X'.repeat(16)) }], ['a colour too large', { colors: [0x1000, 0, 0, 0] }],
    ['a hot spot off the grid', { hotSpot: { x: 16, y: 0 } }], ['too fast a repeat', { keySpeedUs: 19999 }],
    ['a NaN', { keyDelayUs: NaN }], ['a string', { keyDelayUs: '600000' }],
  ])('refuses %s', (_w, o) => expect(sysconfSchema.safeParse({ ...sysconfDefaults(), ...o }).success).toBe(false));
  it('takes the defaults', () => expect(sysconfSchema.safeParse(sysconfDefaults()).success).toBe(true));
});
