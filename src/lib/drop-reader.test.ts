import { describe, it, expect } from 'vitest';
import { readDroppedItems } from './drop-reader';

// The browser's File and Directory Entries API does not exist in vitest, so
// these fakes stand in for it. fakeDirEntry is the one that matters: it
// reproduces the 100-per-call paging trap on purpose. A fake that handed
// back everything in one call would let a single-call implementation pass
// both tests below -- which is exactly the bug this module exists to catch.

const PAGE_SIZE = 100;

function fakeFileEntry(name: string, sizeBytes: number): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(success: (file: File) => void) {
      queueMicrotask(() => success(new File([new Uint8Array(sizeBytes)], name)));
    },
  } as unknown as FileSystemEntry;
}

function fakeDirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let offset = 0;
      return {
        readEntries(success: (entries: FileSystemEntry[]) => void) {
          const page = children.slice(offset, offset + PAGE_SIZE);
          offset += PAGE_SIZE;
          queueMicrotask(() => success(page));
        },
      };
    },
  } as unknown as FileSystemEntry;
}

function fakeItemList(entries: FileSystemEntry[]): DataTransferItemList {
  return entries.map((entry) => ({
    webkitGetAsEntry: () => entry,
  })) as unknown as DataTransferItemList;
}

describe('readDroppedItems', () => {
  it('reads a directory in PAGES until it returns none', async () => {
    // THE TRAP: readEntries returns at most 100 per call and must be called
    // again until it returns an empty array. A single call silently
    // truncates a large folder at exactly 100 items -- green, plausible,
    // and wrong.
    const many = Array.from({ length: 250 }, (_, i) => fakeFileEntry(`f${i}.txt`, 10));
    const dir = fakeDirEntry('Big', many);
    const out = await readDroppedItems(fakeItemList([dir]));
    expect(out.filter((e) => e.kind === 'file')).toHaveLength(250);
  });

  it('preserves nesting and includes empty directories', async () => {
    const tree = fakeDirEntry('Workbench', [
      fakeDirEntry('C', [fakeFileEntry('Assign', 5)]),
      fakeDirEntry('Empty', []),
    ]);
    const out = await readDroppedItems(fakeItemList([tree]));
    expect(out.map((e) => e.path).sort()).toEqual([
      'Workbench', 'Workbench/C', 'Workbench/C/Assign', 'Workbench/Empty',
    ]);
  });
});
