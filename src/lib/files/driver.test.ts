import { describe, it, expect } from 'vitest';
import { driverFor } from './drivers';
import { keepBothName, refuse, Refused, checkName } from './driver';

describe('driverFor', () => {
  it('has LIBRARY: with every operation', () => {
    const lib = driverFor('LIBRARY')!;
    expect(lib.device).toBe('LIBRARY');
    for (const m of ['list', 'read', 'collect', 'within', 'write', 'remove', 'makedir', 'rename', 'setMeta'] as const) {
      expect(typeof lib[m], m).toBe('function');
    }
  });
  it('has NET: (increment 3): boards and their queues, written by copying in, never copied out of', () => {
    const net = driverFor('NET')!;
    expect(net.device).toBe('NET');
    for (const m of ['list', 'read', 'collect', 'within', 'write', 'remove', 'mustRemove'] as const) expect(typeof net[m], m).toBe('function');
    for (const m of ['makedir', 'rename', 'setMeta'] as const) expect(net[m], m).toBeUndefined();
  });
  it('has STASH: listing, reading and collecting (its writes arrive in Task 5)', () => {
    const stash = driverFor('STASH')!;
    expect(stash.device).toBe('STASH');
    for (const m of ['list', 'read', 'collect'] as const) expect(typeof stash[m], m).toBe('function');
  });
});

describe('shared helpers', () => {
  it('refuse throws a Refused carrying the code, status and detail', () => {
    try { refuse('disk_full', 400, 'needs 2 KB, 1 KB free'); } catch (e) {
      expect(e).toBeInstanceOf(Refused);
      expect((e as Refused).refusal).toEqual({ code: 'disk_full', detail: 'needs 2 KB, 1 KB free' });
      expect((e as Refused).status).toBe(400);
    }
  });
  it('checkName refuses with the problem as the detail', () => {
    expect(() => checkName('a:b')).toThrow(Refused);
    expect(() => checkName('ReadMe')).not.toThrow();
  });
  it('keepBothName is the one increment 1 shipped', () => {
    expect(keepBothName('a.txt', (n) => n === 'a_1.txt')).toBe('a_2.txt');
  });
});
