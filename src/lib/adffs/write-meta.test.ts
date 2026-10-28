import { describe, it, expect } from 'vitest';
import { formatVolume } from './format';
import { ROOT_BLOCK } from './constants';
import { addFile, makeDirectory, applyBatch, setComment } from './write';
import { readVolume } from './index';

const when = new Date(Date.UTC(1993, 4, 17, 12, 34, 56, 0));
const must = (r: { ok: true; adf: Uint8Array } | { ok: false; reason: string }) => {
  if (!r.ok) throw new Error(r.reason);
  return r.adf;
};
const root = (adf: Uint8Array) => { const v = readVolume(adf); if (!v.ok) throw new Error(v.reason); return v.root; };

describe('date and comment on write', () => {
  it('addFile keeps the given date and comment', () => {
    const adf = must(addFile(formatVolume({ filesystem: 'FFS', volumeName: 'T' }), ROOT_BLOCK, 'ReadMe',
      new TextEncoder().encode('hi'), 0, { date: when, comment: 'From the bench' }));
    const e = root(adf).find((x) => x.name === 'ReadMe')!;
    expect(e.modifiedAt?.toISOString()).toBe(when.toISOString());
    expect(e.comment).toBe('From the bench');
  });
  it('addFile without meta stamps now, not a recycled date, and no comment', () => {
    const before = Date.now() - 1000;
    const adf = must(addFile(formatVolume({ filesystem: 'OFS', volumeName: 'T' }), ROOT_BLOCK, 'X', new Uint8Array(1)));
    const e = root(adf).find((x) => x.name === 'X')!;
    expect(e.modifiedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(e.comment).toBeNull();
  });
  it('makeDirectory keeps the given date and comment', () => {
    const adf = must(makeDirectory(formatVolume({ filesystem: 'FFS', volumeName: 'T' }), ROOT_BLOCK, 'S',
      { date: when, comment: 'scripts' }));
    const e = root(adf).find((x) => x.name === 'S')!;
    expect(e.kind).toBe('dir');
    expect(e.modifiedAt?.toISOString()).toBe(when.toISOString());
    expect(e.comment).toBe('scripts');
  });
  it('applyBatch carries date and comment for mkdir and add', () => {
    const adf = must(applyBatch([
      { op: 'mkdir', parentPath: '', name: 'C', date: when, comment: 'cmds' },
      { op: 'add', parentPath: 'C', name: 'Assign', bytes: new Uint8Array(10), protection: 0, date: when, comment: 'x' },
    ])(formatVolume({ filesystem: 'FFS', volumeName: 'T' })));
    const c = root(adf).find((x) => x.name === 'C')!;
    expect(c.comment).toBe('cmds');
    const a = c.children.find((x) => x.name === 'Assign')!;
    expect(a.modifiedAt?.toISOString()).toBe(when.toISOString());
    expect(a.comment).toBe('x');
  });
  it('applyBatch replace carries date and comment', () => {
    const base = must(addFile(formatVolume({ filesystem: 'FFS', volumeName: 'T' }), ROOT_BLOCK, 'F', new Uint8Array(1)));
    const adf = must(applyBatch([
      { op: 'replace', parentPath: '', name: 'F', bytes: new Uint8Array(5), date: when, comment: 'r' },
    ])(base));
    const e = root(adf).find((x) => x.name === 'F')!;
    expect(e.modifiedAt?.toISOString()).toBe(when.toISOString());
    expect(e.comment).toBe('r');
  });
  it('setComment replaces and clears a comment, and refuses one over 79 characters', () => {
    let adf = must(addFile(formatVolume({ filesystem: 'FFS', volumeName: 'T' }), ROOT_BLOCK, 'F', new Uint8Array(1),
      0, { comment: 'old' }));
    const block = root(adf).find((x) => x.name === 'F')!.block;
    adf = must(setComment(adf, ROOT_BLOCK, block, 'new one'));
    expect(root(adf).find((x) => x.name === 'F')!.comment).toBe('new one');
    adf = must(setComment(adf, ROOT_BLOCK, block, ''));
    expect(root(adf).find((x) => x.name === 'F')!.comment).toBeNull();
    expect(setComment(adf, ROOT_BLOCK, block, 'x'.repeat(80))).toEqual({ ok: false, reason: 'comment-too-long' });
  });
});
