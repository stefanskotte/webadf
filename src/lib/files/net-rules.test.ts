import { describe, it, expect } from 'vitest';
import { netPollMs, planNetSend, NET_REFRESH_ACTIVE_MS, NET_REFRESH_IDLE_MS } from './net-rules';
import type { Listing } from './types';

const L = (path: string, marks: string[][] = []): Listing => ({ path, crumbs: [], writable: true, readOnlyReason: null, disk: null, meta: '',
  entries: marks.map((m, i) => ({ name: `f${i}`, kind: 'file', path: `${path}/t${i}`, size: 1, date: null, protection: null, comment: null, marks: m })) });

describe('netPollMs', () => {
  it('polls a board queue fast while something waits or sends, slowly otherwise, and nothing elsewhere', () => {
    expect(NET_REFRESH_ACTIVE_MS).toBe(3_000);
    expect(NET_REFRESH_IDLE_MS).toBe(10_000);
    expect(netPollMs(L('NET:/b1/Queue', [['Waiting']]))).toBe(3_000);
    // C6: the sending text carries its percentage, so the rule must not match exact words only.
    expect(netPollMs(L('NET:/b1/Queue', [['Delivered · saved as a.txt'], ['Sending 40 %']]))).toBe(3_000);
    expect(netPollMs(L('NET:/b1/Queue', [['Delivered · saved as a.txt'], ['Cancelled'], ['Expired · the Amiga did not take it within 24 h']]))).toBe(10_000);
    expect(netPollMs(L('NET:/b1/Queue'))).toBe(10_000);
    // NET: volumes (spec 2026-10-30): a board's root and its volumes are read on request, never polled.
    expect(netPollMs(L('NET:/b1', [['Waiting']]))).toBeNull();
    expect(netPollMs(L('NET:/b1/Work/Programs', [['Waiting']]))).toBeNull();
    expect(netPollMs(L('NET:'))).toBeNull();
    expect(netPollMs(L('STASH:'))).toBeNull();
    expect(netPollMs(L('LIBRARY:/g1/d1'))).toBeNull();
    expect(netPollMs(null)).toBeNull();
  });
});

describe('planNetSend', () => {
  const MB = 1024 * 1024;
  it('fits, or names why not', () => {
    expect(planNetSend([MB, MB], { files: 30, bytes: 0 })).toEqual({ ok: true });
    expect(planNetSend([MB, MB, MB], { files: 30, bytes: 0 })).toEqual({ ok: false, why: 'queue_full' });
    expect(planNetSend([10 * MB], { files: 0, bytes: 7 * MB })).toEqual({ ok: false, why: 'queue_full' });
    expect(planNetSend([MB, 5 * MB], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'too_large', index: 1 });
    expect(planNetSend([0], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'empty', index: 0 });
    expect(planNetSend([], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'empty' });
  });
  it('takes exactly 4 MB a file and exactly 32 files / 16 MB a board', () => {
    expect(planNetSend([4 * MB], { files: 0, bytes: 12 * MB })).toEqual({ ok: true });
    expect(planNetSend([4 * MB + 1], { files: 0, bytes: 0 })).toEqual({ ok: false, why: 'too_large', index: 0 });
    expect(planNetSend([1, 1], { files: 30, bytes: 0 })).toEqual({ ok: true });
  });
});
