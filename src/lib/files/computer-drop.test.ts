import { describe, it, expect } from 'vitest';
import type { DroppedItem } from '@/lib/drop-reader';
import { planComputerDrop } from './computer-drop';

const file = (path: string, sizeBytes = 100): DroppedItem => ({ path, kind: 'file', sizeBytes, file: new File(['x'], path) });
const dir = (path: string): DroppedItem => ({ path, kind: 'dir', sizeBytes: 0 });
const disk = { filesystem: 'OFS' as const, intl: false, freeBytes: 100 * 1024 };

describe('planComputerDrop (Files increment 1, Task 9, R5)', () => {
  it('a manifest under the pane\'s folder: folders made, files added, each file\'s part named by its disk path', () => {
    const p = planComputerDrop([dir('Docs'), file('Docs/ReadMe'), file('Notes')], [], { ...disk, parentPath: 'S/Extra' });
    if (!p.ok) throw new Error(p.message ?? 'nothing planned');
    expect(p.manifest).toEqual([
      { op: 'mkdir', path: 'S/Extra/Docs' }, { op: 'add', path: 'S/Extra/Docs/ReadMe' }, { op: 'add', path: 'S/Extra/Notes' },
    ]);
    expect(p.parts.map(([k]) => k)).toEqual(['S/Extra/Docs/ReadMe', 'S/Extra/Notes']);
  });

  it('at the disk root the paths have no prefix', () => {
    const p = planComputerDrop([file('Notes')], [], { ...disk, parentPath: '' });
    expect(p.ok && p.manifest).toEqual([{ op: 'add', path: 'Notes' }]);
  });

  it('a name already in the folder refuses the whole drop, case-insensitively', () => {
    const p = planComputerDrop([file('readme'), file('Other')], [{ name: 'ReadMe', kind: 'file' }], { ...disk, parentPath: '' });
    expect(p).toEqual({ ok: false, message: 'Something with that name is already there: readme.' });
  });

  it('a drop that does not fit is refused whole, with what it needs', () => {
    const p = planComputerDrop([file('Big', 200 * 1024)], [], { ...disk, parentPath: '' });
    expect(p.ok).toBe(false);
    expect(!p.ok && p.message).toMatch(/^Not enough room on the disk — needs \d+ KB, 100 KB free$/);
  });

  it('a long name is shortened to what AmigaDOS holds, and said so', () => {
    const long = 'A-very-long-document-name-indeed.txt';
    const p = planComputerDrop([file(long)], [], { ...disk, parentPath: '' });
    if (!p.ok) throw new Error(p.message ?? 'nothing planned');
    expect(p.manifest[0].path.length).toBeLessThanOrEqual(30);
    expect(p.manifest[0].path.endsWith('.txt')).toBe(true);
    expect(p.renamed).toEqual([[long, p.manifest[0].path]]);
  });

  it('nothing dropped is nothing to do', () => {
    expect(planComputerDrop([], [], { ...disk, parentPath: '' })).toEqual({ ok: false, message: null });
  });
});
