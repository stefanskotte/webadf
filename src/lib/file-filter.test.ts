import { describe, it, expect } from 'vitest';
import type { AdfEntry } from '@/lib/adffs';
import { filterTree } from './file-filter';

let next = 900;
const f = (name: string): AdfEntry => ({ name, kind: 'file', block: next++, sizeBytes: 1, protection: '----rwed', modifiedAt: null, comment: '', children: [] }) as AdfEntry;
const d = (name: string, children: AdfEntry[]): AdfEntry => ({ name, kind: 'dir', block: next++, sizeBytes: 0, protection: '----rwed', modifiedAt: null, comment: '', children }) as AdfEntry;
const names = (list: AdfEntry[]): unknown[] => list.map((e) => (e.kind === 'dir' ? { [e.name]: names(e.children) } : e.name));

const tree = [
  d('C', [f('Dir'), f('Copy'), f('Copy.info')]),
  d('S', [f('Startup-Sequence')]),
  f('Disk.info'),
  f('ReadMe'),
];

describe('filterTree', () => {
  it('with no query and .info shown, is the tree unchanged', () => {
    expect(filterTree(tree, { query: '', hideInfo: false }).entries).toBe(tree);
  });

  it('keeps matches and the folders that lead to them, opening those folders', () => {
    const r = filterTree(tree, { query: 'copy', hideInfo: false });
    expect(names(r.entries)).toEqual([{ C: ['Copy', 'Copy.info'] }]);
    expect([...r.open]).toEqual([tree[0].block]);
  });

  it('a folder whose own name matches keeps everything in it', () => {
    expect(names(filterTree(tree, { query: 's', hideInfo: false }).entries))
      .toEqual([{ S: ['Startup-Sequence'] }, 'Disk.info']);
  });

  it('hides .info files at every level, ignoring case', () => {
    const withUpper = [...tree, f('Tool.INFO')];
    expect(names(filterTree(withUpper, { query: '', hideInfo: true }).entries))
      .toEqual([{ C: ['Dir', 'Copy'] }, { S: ['Startup-Sequence'] }, 'ReadMe']);
  });

  it('a query that matches nothing leaves nothing', () => {
    expect(filterTree(tree, { query: 'zzz', hideInfo: false }).entries).toEqual([]);
  });
});
