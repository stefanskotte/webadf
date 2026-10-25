import { describe, it, expect } from 'vitest';
import { directionPill, toneLook, rowDiskColor, filterAfterKey, FILTERS, EMPTY_UNDER } from '@/lib/upload-look';
import { stagingView, type LibRow, type ServerRow } from '@/lib/upload-staging';
import { driveDiskColor } from '@/lib/library-look';

const server = (o: Partial<ServerRow>): ServerRow => ({ source: 'server', key: 'send:t1', kind: 'out', id: 't1',
  name: 'f.bin', sizeBytes: 11, board: { id: 'd1', name: 'Bench' }, status: 'queued', doneBytes: 0, pct: null,
  savedAs: null, error: null, isDiskImage: false, title: null, at: 1, ...o });
const lib = (o: Partial<LibRow>): LibRow => ({ source: 'lib', key: 'lib:1', kind: 'lib', name: 'a.adf',
  sizeBytes: 901_120, state: 'done', title: null, at: 1, ...o });
const view = (r: ServerRow | LibRow) => stagingView([r], 'all', new Set()).shown[0];

describe('directionPill (spec §3)', () => {
  it.each([
    ['lib', 'To library', '↓', 'var(--track)', 'var(--muted)'],
    ['out', 'To Amiga', '→', 'var(--to-amiga-bg)', 'var(--accent-blue)'],
    ['in', 'From Amiga', '←', 'var(--from-amiga-bg)', 'var(--from-amiga-fg)'],
  ] as const)('%s', (kind, label, arrow, bg, fg) => {
    expect(directionPill(kind)).toEqual({ label, arrow, bg, fg });
  });
});

describe('toneLook (spec §3, Ruling 28)', () => {
  it.each([
    ['done', 'var(--success-fg)', 'var(--online-dot)'],
    ['busy', 'var(--warning-fg)', 'var(--fetch-dot)'],
    ['wait', 'var(--muted)', 'var(--dash)'],
    ['fail', 'var(--danger-fg)', 'var(--danger-fg)'],
  ] as const)('%s', (tone, fg, dot) => {
    expect(toneLook(tone)).toEqual({ fg, dot });
  });
});

describe('rowDiskColor (Ruling 17)', () => {
  it('a failed row is cream', () => {
    expect(rowDiskColor(view(lib({ state: 'failed', note: 'No disk images inside' })))).toBe('cream');
    expect(rowDiskColor(view(server({ status: 'failed' })))).toBe('cream');
  });
  it('a row with a title takes the title colour', () => {
    const t = { gameId: 'g-42', title: 'Turrican II' };
    expect(rowDiskColor(view(lib({ title: t })))).toBe(driveDiskColor('g-42'));
    expect(rowDiskColor(view(server({ key: 'amiga:u1', kind: 'in', status: 'stored', isDiskImage: true, title: t }))))
      .toBe(driveDiskColor('g-42'));
  });
  it('otherwise by direction', () => {
    expect(rowDiskColor(view(server({ status: 'queued' })))).toBe('blue');
    expect(rowDiskColor(view(server({ key: 'amiga:u1', kind: 'in', status: 'stored', isDiskImage: true })))).toBe('black');
    expect(rowDiskColor(view(server({ key: 'amiga:u1', kind: 'in', status: 'stored', isDiskImage: false })))).toBe('grey');
    expect(rowDiskColor(view(lib({ state: 'hashing' })))).toBe('black');
  });
});

describe('filterAfterKey', () => {
  it('moves in FILTERS order and wraps', () => {
    expect(FILTERS.map((f) => f.id)).toEqual(['all', 'in', 'out', 'lib']);
    expect(filterAfterKey('all', 'ArrowRight')).toBe('in');
    expect(filterAfterKey('in', 'ArrowDown')).toBe('out');
    expect(filterAfterKey('lib', 'ArrowRight')).toBe('all');
    expect(filterAfterKey('all', 'ArrowLeft')).toBe('lib');
    expect(filterAfterKey('out', 'ArrowUp')).toBe('in');
    expect(filterAfterKey('out', 'Home')).toBe('all');
    expect(filterAfterKey('in', 'End')).toBe('lib');
    expect(filterAfterKey('in', 'a')).toBeNull();
  });
  it('keeps the A6 words', () => {
    expect(FILTERS.map((f) => f.label)).toEqual(['All', 'From the Amiga', 'To the Amiga', 'To the library']);
    expect(EMPTY_UNDER).toEqual({ lib: 'Nothing to the library right now.', out: 'Nothing to the Amiga right now.',
      in: 'Nothing from the Amiga right now.' });
  });
});
