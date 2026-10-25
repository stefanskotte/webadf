import { describe, it, expect } from 'vitest';
import {
  entryGlyph, protectionChips, infoCompanions, countInfo, countTree, changeCounts, driveLight, driveBadge, densityPill,
  openByDefault, formatKb, plural,
} from '@/lib/disk-files-look';
import type { AdfEntry } from '@/lib/adffs';
import type { MountChoice } from '@/lib/mount-choice';
import type { HistoryVersion } from '@/lib/disk-history/history';

const f = (name: string, block: number, o: Partial<AdfEntry> = {}): AdfEntry => ({ name, kind: 'file', block,
  sizeBytes: 1, modifiedAt: null, protection: '----rwed', comment: null, children: [], ...o });
const d = (name: string, block: number, children: AdfEntry[] = []): AdfEntry => f(name, block, { kind: 'dir', children });
const choice = (o: Partial<MountChoice>): MountChoice => ({ id: 'b1', name: 'Bench', state: 'empty', holding: null,
  isThisDisk: false, action: 'mount', actionLabel: 'Mount', revertDiskId: null, df1: null, df1Held: false,
  df1Stale: false, ...o }) as MountChoice;
const v = (seq: number, isHead = false): HistoryVersion => ({ seq, isHead, label: 'Edited in browser',
  createdAt: new Date(0), changes: [], sectorNote: null }) as unknown as HistoryVersion;

describe('entryGlyph (spec §5.5, Ruling 14)', () => {
  it.each([
    [d('C', 1), 'DIR', 'var(--dir-bg)', 'var(--accent-blue)'],
    [f('Disk.info', 2), 'ICN', 'var(--track)', 'var(--muted-2)'],
    [f('ReadMe.info', 3), 'ICN', 'var(--track)', 'var(--muted-2)'],
    [f('notes.TXT', 4), 'TXT', 'var(--track)', 'var(--muted)'],
    [f('ReadMe', 5), 'TXT', 'var(--track)', 'var(--muted)'],
    [f('wbconfig.prefs', 6), 'TXT', 'var(--track)', 'var(--muted)'],
    [f('SetPatch', 7), 'EXE', 'var(--exe-bg)', 'var(--exe-fg)'],
    [f('.hidden', 8), 'EXE', 'var(--exe-bg)', 'var(--exe-fg)'],
    [f('tune.mod', 9), 'MOD', 'var(--track)', 'var(--muted)'],
    [f('archive.lha', 10), 'LHA', 'var(--track)', 'var(--muted)'],
    [f('dos.library', 11), 'LIB', 'var(--track)', 'var(--muted)'],
  ] as const)('%o → %s', (e, label, bg, fg) => {
    expect(entryGlyph(e)).toEqual({ label, bg, fg });
  });
});

describe('protectionChips (Ruling 13)', () => {
  it('is eight chips in h s p a r w e d order, set by the string', () => {
    const c = protectionChips('-s--rwe-');
    expect(c.map((x) => x.letter).join('')).toBe('hsparwed');
    expect(c.map((x) => (x.on ? x.letter : '-')).join('')).toBe('-s--rwe-');
    expect(c[0].label).toBe('Hidden');
  });
});

describe('infoCompanions (Ruling 15)', () => {
  it('marks an entry whose .info sits beside it, at every level, case-insensitively', () => {
    const tree = [d('Prefs', 1, [f('Presets', 4), f('presets.INFO', 5)]), f('Prefs.info', 2), f('Disk.info', 3)];
    expect([...infoCompanions(tree)].sort()).toEqual([1, 4]);
  });
});

describe('countTree / changeCounts / formatKb', () => {
  it('counts .info files at every level', () => {
    expect(countInfo([d('A', 1, [f('x.info', 2)]), f('A.info', 3), f('y', 4)])).toBe(2);
  });
  it('counts the whole tree', () => {
    expect(countTree([d('A', 1, [f('x', 2), d('B', 3, [f('y', 4)])]), f('z', 5)])).toEqual({ files: 3, dirs: 2 });
  });
  it('counts changes by kind', () => {
    expect(changeCounts([{ path: 'a', kind: 'added', isDir: false }, { path: 'b', kind: 'added', isDir: true },
      { path: 'c', kind: 'removed', isDir: false }])).toEqual({ added: 2, changed: 0, removed: 1 });
  });
  it('rounds to KB', () => { expect(formatKb(2048)).toBe('2 KB'); expect(formatKb(899_072)).toBe('878 KB'); });
  it('plurals', () => { expect(plural(1, 'folder')).toBe('1 folder'); expect(plural(0, 'file')).toBe('0 files');
    expect(plural(2, '.info file')).toBe('2 .info files'); });
});

describe('driveLight / driveBadge (spec §2, the holderText ranking)', () => {
  it('none, stale, moving, in', () => {
    expect(driveLight([choice({})])).toBe('none');
    expect(driveLight([choice({ isThisDisk: true, state: 'stale' })])).toBe('stale');
    expect(driveLight([choice({ isThisDisk: true, state: 'pending' })])).toBe('moving');
    expect(driveLight([choice({ isThisDisk: true, state: 'converged' })])).toBe('in');
    expect(driveLight([choice({ df1: { isThisDisk: true } as MountChoice['df1'], df1Held: true })])).toBe('in');
    expect(driveLight([choice({ df1: { isThisDisk: true } as MountChoice['df1'] })])).toBe('moving');
    expect(driveLight([choice({ df1: { isThisDisk: true } as MountChoice['df1'], df1Stale: true })])).toBe('stale');
  });
  it('the badge names the drive that confirmed it', () => {
    expect(driveBadge([choice({ isThisDisk: true, state: 'converged' })])).toBe('DF0');
    expect(driveBadge([choice({ df1Held: true })])).toBe('DF1');
    expect(driveBadge([choice({ isThisDisk: true, state: 'pending' })])).toBeNull();
  });
});

describe('densityPill / openByDefault', () => {
  it('HD from the root block, else from the size', () => {
    expect(densityPill(1760, 0)).toBe('HD · 1.76 MB');
    expect(densityPill(880, 901_120)).toBe('DD · 880 KB');
    expect(densityPill(880, 1_802_240)).toBe('HD · 1.76 MB');
  });
  it('opens the head and the version on screen', () => {
    const vs = [v(3, true), v(2), v(1), v(0)];
    expect([...openByDefault(vs, null)]).toEqual([3]);
    expect([...openByDefault(vs, 1)].sort()).toEqual([1, 3]);
    expect([...openByDefault([], null)]).toEqual([]);
  });
});
