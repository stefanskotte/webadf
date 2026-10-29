import { describe, it, expect } from 'vitest';
import { traySummary, trayState } from './tray';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = (state: any, note?: string) => ({ source: 'lib', key: `lib:${Math.random()}`, kind: 'lib', name: 'x.adf', sizeBytes: 1, state, note, title: null, at: 0 }) as any;
describe('tray', () => {
  it('sums what happened', () => {
    expect(traySummary([row('done'), row('done'), row('deduped'), row('failed', 'bad')])).toBe('2 added · 1 already in the library · 1 refused');
    expect(traySummary([row('hashing'), row('done')])).toBe('1 added · 1 working');
  });
  it('words each state', () => {
    expect(trayState(row('uploading'))).toEqual({ word: 'Uploading…', tone: 'busy' });
    expect(trayState(row('deduped'))).toEqual({ word: 'Already in the library', tone: 'done' });
    expect(trayState(row('failed', 'not a disk'))).toEqual({ word: 'Refused — not a disk', tone: 'fail' });
  });
});

describe('tray order', () => {
  it('puts the newest drop first, keeps each drop in its own order, and moves a disk dropped again', async () => {
    const { stampDrops, trayOrder } = await import('./tray');
    const r = (key: string, at: number, state = 'hashing') => ({ ...row(state), key, at });
    const one = [r('a', 1), r('b', 2)];
    let dropOf = stampDrops([], one, new Map(), 1);
    // A state patch keeps its drop.
    const patched = [{ ...one[0], state: 'done' }, one[1]];
    dropOf = stampDrops(one, patched, dropOf, 1);
    // Drop 2 brings c, and b again (made afresh: a new `at`).
    const two = [patched[0], r('b', 5), r('c', 6)];
    dropOf = stampDrops(patched, two, dropOf, 2);
    expect(trayOrder(two, dropOf).map((x) => x.key)).toEqual(['b', 'c', 'a']);
    // Drop 3 brings d, then a again in the same update: its order, not the array's.
    const three = [r('a', 9), two[1], two[2], r('d', 8)];
    dropOf = stampDrops(two, [two[0], two[1], two[2], three[3]], dropOf, 3);
    dropOf = stampDrops([two[0], two[1], two[2], three[3]], three, dropOf, 3);
    expect(trayOrder(three, dropOf).map((x) => x.key)).toEqual(['d', 'a', 'b', 'c']);
    // Emptied rows leave nothing behind.
    expect(stampDrops(two, [], dropOf, 3).size).toBe(0);
  });
});
