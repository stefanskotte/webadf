import { describe, it, expect } from 'vitest';
import { protectionString } from '@/lib/adffs/dir';
import type { AdfEntry } from '@/lib/adffs';
import { pickFiles, protectionBits } from './send-from-disk';

const f = (block: number, name: string, protection = '----rwed', comment: string | null = null): AdfEntry =>
  ({ block, name, kind: 'file', sizeBytes: 10, modifiedAt: null, protection, comment, children: [] });
const d = (block: number, name: string, children: AdfEntry[]): AdfEntry =>
  ({ block, name, kind: 'dir', sizeBytes: 0, modifiedAt: null, protection: '----rwed', comment: null, children });

const tree = [d(10, 'mods', [f(11, 'axelf.mod', '-s--rwed', 'by Harold'), d(12, 'empty', []), d(13, 'more', [f(14, 'b.mod')])]),
  f(20, 'Readme')];

describe('protectionBits', () => {
  it('reads back exactly what protectionString wrote (R5: the low eight bits)', () => {
    for (const bits of [0, 0x01, 0x0f, 0x40, 0xf0, 0xff, 0x4d]) expect(protectionBits(protectionString(bits))).toBe(bits);
  });
  it('treats anything that is not an hsparwed string as no bits', () => {
    expect(protectionBits('rwed')).toBe(0);
  });
});

describe('pickFiles', () => {
  it('a file arrives by its own name, a folder under its own name with everything in it (R4)', () => {
    expect(pickFiles(tree, [20]).map((p) => p.path)).toEqual(['Readme']);
    expect(pickFiles(tree, [11]).map((p) => p.path)).toEqual(['axelf.mod']);
    expect(pickFiles(tree, [10]).map((p) => p.path)).toEqual(['mods/axelf.mod', 'mods/more/b.mod']);
    expect(pickFiles(tree, [13]).map((p) => p.path)).toEqual(['more/b.mod']);
  });
  it('carries protection and comment, skips empty folders, and never sends a file twice', () => {
    const [ax] = pickFiles(tree, [10]);
    expect(ax).toMatchObject({ block: 11, protection: 0x40, comment: 'by Harold', sizeBytes: 10 });
    expect(pickFiles(tree, [12])).toEqual([]);
    expect(pickFiles(tree, [10, 11]).map((p) => p.block)).toEqual([11, 14]);
  });
  it('finds nothing for a block that is not in the tree', () => {
    expect(pickFiles(tree, [999])).toEqual([]);
  });
});
