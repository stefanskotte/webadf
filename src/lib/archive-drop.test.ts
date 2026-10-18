import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchiveResult } from './archive';
import type { DroppedItem } from './drop-reader';
import { stageDrop, type ExistingEntry } from './staging';
import { blocksForPlan } from './adffs';
import { MAX_DEPTH } from './adffs/constants';
import {
  archiveToDroppedItems, expandArchivesInDrop, stagingSummary, pathTooDeep,
} from './archive-drop';

const fx = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'archive', 'fixtures', n)));
const fileItem = (name: string, bytes: Uint8Array): DroppedItem => ({
  path: name, kind: 'file', sizeBytes: bytes.length,
  file: new File([bytes as unknown as BlobPart], name),
});
const member = (path: string, text = 'x', protection: number | null = null) => ({
  path, bytes: new TextEncoder().encode(text), protection,
});
const lha = (members: ReturnType<typeof member>[], skipped: ArchiveResult['skipped'] = []): ArchiveResult =>
  ({ format: 'lha', members, skipped });

describe('archiveToDroppedItems', () => {
  it('creates every parent folder once, parents before children, then the files', () => {
    const { items } = archiveToDroppedItems('a.lha', lha([
      member('src/sub/deep.txt'), member('src/readme.txt'), member('top.txt'),
    ]));
    expect(items.map((i) => `${i.kind}:${i.path}`)).toEqual([
      'dir:src', 'dir:src/sub',
      'file:src/sub/deep.txt', 'file:src/readme.txt', 'file:top.txt',
    ]);
  });

  it('carries bytes, size and protection through to each file', async () => {
    const { items } = archiveToDroppedItems('a.lha', lha([member('C/Foo', 'abc', 0x0f)]));
    const f = items.find((i) => i.kind === 'file')!;
    expect(f.sizeBytes).toBe(3);
    expect(f.protection).toBe(0x0f);
    expect(f.file!.name).toBe('Foo');
    expect(new TextDecoder().decode(new Uint8Array(await f.file!.arrayBuffer()))).toBe('abc');
  });

  it('keeps "said nothing" protection as null, never 0', () => {
    const { items } = archiveToDroppedItems('a.lha', lha([member('x')]));
    expect(items[0].protection).toBeNull();
  });

  it('reports what the reader skipped, against the archive it came from', () => {
    const { skipped } = archiveToDroppedItems('a.lha', lha([member('ok')], [{ path: 'old', reason: 'unsupported method -lh1-' }]));
    expect(skipped).toEqual([{ archive: 'a.lha', path: 'old', reason: 'unsupported method -lh1-' }]);
  });

  it('refuses a member path that tries to climb out, rather than writing it', () => {
    const { items, skipped } = archiveToDroppedItems('evil.lha', lha([
      member('../escape.txt'), member('a/./b.txt'), member('fine.txt'),
    ]));
    expect(items.map((i) => i.path)).toEqual(['fine.txt']);
    expect(skipped.map((s) => s.path)).toEqual(['../escape.txt', 'a/./b.txt']);
    expect(skipped.every((s) => s.reason === 'unsafe path')).toBe(true);
  });

  it('collapses doubled separators instead of creating an empty-named folder', () => {
    const { items } = archiveToDroppedItems('a.lha', lha([member('a//b.txt')]));
    expect(items.map((i) => i.path)).toEqual(['a', 'a/b.txt']);
  });

  it('keeps only the LAST copy of a path an archive holds twice (LHA appends updates)', async () => {
    const { items, skipped } = archiveToDroppedItems('a.lha', lha([member('x.txt', 'old'), member('x.txt', 'new')]));
    const files = items.filter((i) => i.kind === 'file');
    expect(files).toHaveLength(1);
    expect(new TextDecoder().decode(new Uint8Array(await files[0].file!.arrayBuffer()))).toBe('new');
    expect(skipped).toEqual([{ archive: 'a.lha', path: 'x.txt', reason: 'duplicate (the later copy is used)' }]);
  });

  it('refuses a member nested deeper than the filesystem reader will walk', () => {
    const deep = `${Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`).join('/')}/f.txt`;
    const { items, skipped } = archiveToDroppedItems('a.lha', lha([member(deep), member('ok.txt')]));
    expect(items.map((i) => i.path)).toEqual(['ok.txt']);
    expect(skipped[0]).toMatchObject({ path: deep, reason: 'nested too deep' });
  });
});

describe('the archive goes through the SAME staging rules as a dropped folder', () => {
  it('flags a member colliding (case-folded) with a file already in the target folder', () => {
    const { items } = archiveToDroppedItems('a.lha', lha([member('README'), member('new.txt')]));
    const existing = new Map<string, ExistingEntry[]>([['', [{ name: 'readme', kind: 'file' }]]]);
    const staged = stageDrop(items, existing, false);
    expect(staged.find((s) => s.path === 'README')).toMatchObject({ collidesWith: 'existing', existingKind: 'file' });
    expect(staged.find((s) => s.path === 'new.txt')?.collidesWith).toBeNull();
  });

  it('shortens a member name past 30 characters and marks it', () => {
    const long = `${'a'.repeat(40)}.txt`;
    const { items } = archiveToDroppedItems('a.lha', lha([member(long)]));
    const [s] = stageDrop(items, new Map(), false);
    expect(s.name).toHaveLength(30);
    expect(s.shortened).toBe(true);
  });

  it('a folder the archive needs that already exists on the disk is a folder-merge collision', () => {
    const { items } = archiveToDroppedItems('a.lha', lha([member('C/Foo')]));
    const existing = new Map<string, ExistingEntry[]>([['', [{ name: 'c', kind: 'dir' }]]]);
    const [dir] = stageDrop(items, existing, false);
    expect(dir).toMatchObject({ kind: 'dir', collidesWith: 'existing', existingKind: 'dir' });
  });

  it('a real archive that inflates past a blank disk does not fit, judged in blocks', async () => {
    const { items } = await expandArchivesInDrop([fileItem('toobig.lha', fx('toobig.lha'))]);
    // 653 bytes on the wire, a megabyte inside: the size that matters is the
    // decoded one, and a DD disk holds 1,756 free blocks when blank.
    expect(items.find((i) => i.path.endsWith('zeros.bin'))?.sizeBytes).toBe(1024 * 1024);
    expect(blocksForPlan(items, 'FFS')).toBeGreaterThan(1756);
  });
});

describe('expandArchivesInDrop', () => {
  it('passes plain files and folders through untouched', async () => {
    const plain = fileItem('notes.txt', new TextEncoder().encode('hi'));
    const dir: DroppedItem = { path: 'D', kind: 'dir', sizeBytes: 0 };
    const out = await expandArchivesInDrop([plain, dir]);
    expect(out.items).toEqual([plain, dir]);
    expect(out.refused).toEqual([]);
  });

  it('expands a real .lha into its folders and members, and the archive itself is not a row', async () => {
    const out = await expandArchivesInDrop([fileItem('h1.lha', fx('h1.lha'))]);
    expect(out.items.map((i) => i.path)).toEqual(expect.arrayContaining(['src', 'src/sub', 'src/readme.txt', 'src/sub/deep.txt']));
    expect(out.items.some((i) => i.path === 'h1.lha')).toBe(false);
  });

  it('expands a real .lzh the same way', async () => {
    const out = await expandArchivesInDrop([fileItem('m5.lzh', fx('m5.lzh'))]);
    expect(out.items.some((i) => i.path.endsWith('readme.txt'))).toBe(true);
  });

  it('refuses a corrupt archive by name, writing nothing from it', async () => {
    const junk = new TextEncoder().encode('this is not an LHA archive at all, just text');
    const out = await expandArchivesInDrop([fileItem('broken.lha', junk)]);
    expect(out.items).toEqual([]);
    expect(out.refused).toEqual([{ name: 'broken.lha', message: expect.stringMatching(/not an \.lha, \.lzh or \.zip/) }]);
  });

  it('refuses a truncated real archive rather than staging a short file', async () => {
    const full = fx('h1.lha');
    const out = await expandArchivesInDrop([fileItem('cut.lha', full.subarray(0, 60))]);
    // Whatever survived must be whole; the damage is named, not silently dropped.
    expect(out.items.filter((i) => i.kind === 'file').length + out.refused.length).toBeGreaterThanOrEqual(1);
    expect(out.skipped.length + out.refused.length).toBeGreaterThan(0);
  });
});

describe('stagingSummary', () => {
  it('counts files, folders and the bytes that will be written', () => {
    expect(stagingSummary([
      { kind: 'dir', sizeBytes: 0 }, { kind: 'file', sizeBytes: 10 }, { kind: 'file', sizeBytes: 5 },
    ])).toEqual({ files: 2, folders: 1, bytes: 15 });
  });
});

describe('pathTooDeep', () => {
  it('allows MAX_DEPTH path segments and refuses one more', () => {
    const at = Array.from({ length: MAX_DEPTH }, () => 'a').join('/');
    expect(pathTooDeep(at)).toBe(false);
    expect(pathTooDeep(`${at}/b`)).toBe(true);
  });
});
